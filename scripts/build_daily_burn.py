#!/usr/bin/env python3
"""Merge exact daily usage with labeled estimates into data/daily-burn.json.

Strategy: additive / append-only ledger.
  - Any row already in daily-burn.json that has nonzero exact data is
    treated as frozen. Even if the source logs are later pruned, the row
    keeps its captured counts.
  - Rows with only estimates (or zero exact data) can be updated on each
    run in case the estimate assumptions change.
  - New days discovered in exact-daily.json are appended.

This means historical exact data survives log pruning. Only estimated rows
drift if you change the patterns below, which is the desired behaviour.

Exact columns come from data/exact-daily.json (see extract_exact.py).
Estimated columns are conservative, deterministic weekday patterns based on
a user interview on 2026-06-12 — the assumptions are documented in
ESTIMATES.md and must be updated there if changed here.

Driver labels and evidence notes are generic by design (no project or
client names) so the output is safe to share or deploy.
"""
from __future__ import annotations  # allow X | Y union syntax on Python 3.9

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

RANGE_START = date(2026, 5, 4)  # first day with exact logs

# Estimate patterns (tokens per day, by weekday number Mon=0..Sun=6).
# See ESTIMATES.md for the reasoning behind each number.
CLAUDE_CHAT_EST = {0: 30_000, 1: 30_000, 2: 30_000, 3: 30_000, 4: 30_000}
CHATGPT_EST = {0: 15_000, 2: 15_000, 4: 15_000}
GEMINI_EST = {0: 8_000, 1: 50_000, 3: 50_000, 4: 8_000}

# Generic per-day driver labels for days with exact usage, inferred from
# which local project dominated that day's tokens (data/private/day-detail.json).
DRIVERS = {
    "2026-05-04": ("shipping", "web app feature work (exact logs)"),
    "2026-05-05": ("shipping", "web app feature work (exact logs)"),
    "2026-05-09": ("shipping", "web app feature work (exact logs)"),
    "2026-05-11": ("shipping", "heavy web app build day (exact logs)"),
    "2026-05-13": ("shipping", "web app feature work (exact logs)"),
    "2026-05-14": ("shipping", "web app feature work (exact logs)"),
    "2026-05-16": ("shipping", "web app feature work (exact logs)"),
    "2026-05-19": ("admin", "ad hoc scripting (exact logs)"),
    "2026-05-24": ("admin", "personal finance tooling (exact logs)"),
    "2026-05-25": ("admin", "heavy finance tooling day (exact logs)"),
    "2026-05-26": ("admin", "personal finance tooling (exact logs)"),
    "2026-06-01": ("admin", "personal finance tooling (exact logs)"),
    "2026-06-02": ("shipping", "web app feature work (exact logs)"),
    "2026-06-03": ("shipping", "web app feature work (exact logs)"),
    "2026-06-04": ("shipping", "web app feature work (exact logs)"),
    "2026-06-08": ("research", "evaluating a second coding agent (exact logs)"),
    "2026-06-10": ("research", "AI usage analysis and site updates (exact logs)"),
    "2026-06-11": ("shipping", "personal site updates (exact logs)"),
    "2026-06-12": ("research", "building this usage dashboard (exact logs)"),
    "2026-06-15": ("shipping", "web app and portal work (exact logs)"),
    "2026-06-16": ("admin", "personal finance tooling (exact logs)"),
    "2026-06-17": ("admin", "personal finance tooling (exact logs)"),
    "2026-06-19": ("research", "second coding agent evaluation (exact logs)"),
    "2026-06-30": ("shipping", "web portal work (exact logs)"),
    "2026-07-02": ("shipping", "web app feature work (exact logs)"),
    "2026-07-03": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-04": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-05": ("shipping", "web app feature work (exact logs)"),
    "2026-07-06": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-07": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-08": ("shipping", "web app feature work (exact logs)"),
    "2026-07-09": ("shipping", "web app feature work (exact logs)"),
    "2026-07-10": ("shipping", "web app feature work (exact logs)"),
}

CHAT_ONLY = ("research", "chat-only day; all values estimated")


def load_existing(path: Path) -> dict:
    """Load existing daily-burn.json keyed by date, or {} if absent."""
    if not path.exists():
        return {}
    rows = json.load(open(path))
    return {r["date"]: r for r in rows}


def has_exact_data(row: dict) -> bool:
    return (row.get("codex_tokens") or 0) + (row.get("claude_code_tokens") or 0) > 0


def build_row(key: str, ex: dict, frozen_exact: dict | None) -> dict:
    wd = date.fromisoformat(key).weekday()
    claude_chat = CLAUDE_CHAT_EST.get(wd, 0)
    chatgpt = CHATGPT_EST.get(wd, 0)
    gemini = GEMINI_EST.get(wd, 0)

    if frozen_exact:
        # Preserve captured exact counts; only refresh estimates and driver label.
        codex = frozen_exact["codex_tokens"]
        claude_code = frozen_exact["claude_code_tokens"]
        calls = frozen_exact["claude_code_calls"]
    else:
        codex = ex.get("codex_tokens", 0)
        claude_code = ex.get("claude_code_tokens", 0)
        calls = ex.get("claude_code_calls", 0)

    if key in DRIVERS:
        driver, evidence = DRIVERS[key]
    elif codex or claude_code:
        driver, evidence = "unlabeled", "exact logs; add a driver label for this day"
    else:
        driver, evidence = CHAT_ONLY

    return {
        "date": key,
        "codex_tokens": codex,
        "claude_code_tokens": claude_code,
        "claude_code_calls": calls,
        "claude_chat_est": claude_chat,
        "chatgpt_est": chatgpt,
        "gemini_est": gemini,
        "total": codex + claude_code + claude_chat + chatgpt + gemini,
        "driver": driver,
        "evidence": evidence,
    }


def main():
    exact = {row["date"]: row for row in json.load(open(DATA / "exact-daily.json"))}
    out_path = DATA / "daily-burn.json"
    existing = load_existing(out_path)

    # Determine range: from RANGE_START to the latest date seen in either source.
    all_dates = set(exact.keys()) | set(existing.keys())
    if not all_dates:
        print("no data found")
        return
    end = max(date.fromisoformat(d) for d in all_dates)

    rows = []
    frozen_count = 0
    new_count = 0

    day = RANGE_START
    while day <= end:
        key = day.isoformat()
        wd = day.weekday()
        ex = exact.get(key, {})
        prev = existing.get(key)
        claude_chat = CLAUDE_CHAT_EST.get(wd, 0)
        chatgpt = CHATGPT_EST.get(wd, 0)
        gemini = GEMINI_EST.get(wd, 0)
        has_any = ex or (claude_chat or chatgpt or gemini) or prev

        if not has_any:
            day += timedelta(days=1)
            continue  # weekend with nothing at all

        # Freeze a row if it previously had exact data, even if logs are now gone.
        frozen = prev if (prev and has_exact_data(prev) and not ex) else None
        if frozen:
            frozen_count += 1
        else:
            new_count += 1

        rows.append(build_row(key, ex, frozen))
        day += timedelta(days=1)

    with open(out_path, "w") as fh:
        json.dump(rows, fh, indent=2)

    now = datetime.now(ZoneInfo("America/Chicago"))
    meta = {"refreshed_at": now.isoformat(timespec="seconds")}
    with open(DATA / "meta.json", "w") as fh:
        json.dump(meta, fh)

    print(f"wrote {len(rows)} rows  ({frozen_count} frozen from previous capture, {new_count} live/new)")
    print(f"grand total: {sum(r['total'] for r in rows):,} tokens")
    print(f"refreshed_at: {meta['refreshed_at']}")


if __name__ == "__main__":
    main()
