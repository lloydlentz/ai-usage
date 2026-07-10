#!/usr/bin/env python3
"""Extract exact daily token usage from local Claude Code and Codex logs.

Outputs:
  data/exact-daily.json   - scrubbed daily totals (safe to feed the dashboard)
  data/private/day-detail.json - per-project breakdown for driver labeling.
                                 Stays local; never ship or deploy this file.

Day bucketing uses America/Chicago.
"""

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Chicago")
HOME = Path.home()
OUT_DIR = Path(__file__).resolve().parent.parent / "data"
PRIVATE_DIR = OUT_DIR / "private"


def local_date(iso_ts: str) -> str:
    ts = iso_ts.replace("Z", "+00:00")
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ).strftime("%Y-%m-%d")


def extract_claude_code():
    """Per-day exact tokens and API call counts from ~/.claude/projects."""
    daily_tokens = defaultdict(int)
    daily_calls = defaultdict(int)
    day_projects = defaultdict(lambda: defaultdict(int))
    seen = set()

    for path in (HOME / ".claude" / "projects").rglob("*.jsonl"):
        project = path.parent.name
        with open(path) as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "assistant":
                    continue
                message = entry.get("message") or {}
                usage = message.get("usage")
                ts = entry.get("timestamp")
                if not usage or not ts:
                    continue
                # The same API call can be written to multiple transcript
                # files (continued/forked sessions); count it once.
                key = (message.get("id"), entry.get("requestId"))
                if key != (None, None) and key in seen:
                    continue
                seen.add(key)
                tokens = (
                    usage.get("input_tokens", 0)
                    + usage.get("cache_creation_input_tokens", 0)
                    + usage.get("cache_read_input_tokens", 0)
                    + usage.get("output_tokens", 0)
                )
                day = local_date(ts)
                daily_tokens[day] += tokens
                daily_calls[day] += 1
                day_projects[day][project] += tokens

    return daily_tokens, daily_calls, day_projects


def extract_codex():
    """Per-day exact tokens from ~/.codex session rollouts.

    token_count events carry a cumulative total per session, so each
    session contributes its final total, bucketed to the day of its
    last token_count event.
    """
    daily_tokens = defaultdict(int)
    session_dirs = [HOME / ".codex" / "sessions", HOME / ".codex" / "archived_sessions"]

    for root in session_dirs:
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            last_total = 0
            last_ts = None
            with open(path) as fh:
                for line in fh:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    payload = entry.get("payload") or {}
                    if payload.get("type") != "token_count":
                        continue
                    info = payload.get("info") or {}
                    total = (info.get("total_token_usage") or {}).get("total_tokens")
                    if total is not None:
                        last_total = total
                        last_ts = entry.get("timestamp")
            if last_total and last_ts:
                daily_tokens[local_date(last_ts)] += last_total

    return daily_tokens


def main():
    cc_tokens, cc_calls, day_projects = extract_claude_code()
    codex_tokens = extract_codex()

    all_days = sorted(set(cc_tokens) | set(codex_tokens))
    rows = [
        {
            "date": day,
            "codex_tokens": codex_tokens.get(day, 0),
            "claude_code_tokens": cc_tokens.get(day, 0),
            "claude_code_calls": cc_calls.get(day, 0),
        }
        for day in all_days
    ]

    OUT_DIR.mkdir(exist_ok=True)
    PRIVATE_DIR.mkdir(exist_ok=True)

    with open(OUT_DIR / "exact-daily.json", "w") as fh:
        json.dump(rows, fh, indent=2)

    detail = {
        day: dict(sorted(projects.items(), key=lambda kv: -kv[1]))
        for day, projects in sorted(day_projects.items())
    }
    with open(PRIVATE_DIR / "day-detail.json", "w") as fh:
        json.dump(detail, fh, indent=2)

    total_cc = sum(cc_tokens.values())
    total_codex = sum(codex_tokens.values())
    print(f"days: {len(rows)}  claude_code: {total_cc:,}  codex: {total_codex:,}")
    print(f"wrote {OUT_DIR / 'exact-daily.json'} and {PRIVATE_DIR / 'day-detail.json'}")


if __name__ == "__main__":
    main()
