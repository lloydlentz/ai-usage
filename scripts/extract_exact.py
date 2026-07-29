#!/usr/bin/env python3
"""Extract exact daily token usage from local Claude Code and Codex logs.

Outputs:
  data/exact-daily.json   - scrubbed daily totals (safe to feed the dashboard)
  data/private/day-detail.json - per-project breakdown for driver labeling,
                                 combining both Claude Code (keyed by project
                                 directory) and Codex (keyed by session cwd)
                                 usage. Stays local; never ship or deploy this
                                 file.

Day bucketing uses America/Chicago.

Per-type, per-model breakdown
-----------------------------
Each day carries a `breakdown` alongside the aggregate columns. The aggregates
(`claude_code_tokens`, `codex_tokens`, `claude_code_calls`) keep their old
meaning exactly, so nothing downstream breaks; the breakdown is additive.

The breakdown exists because the four token types are not interchangeable.
Cache reads bill at a tenth of base input, cache writes at a premium, output
at several times input -- and cache reads are ~96% of this dataset's raw
token volume. Summing all four at equal weight makes a long cached session
look like a huge amount of work, which is why the aggregate alone is a bad
headline and why the breakdown has to exist for cost to mean anything.

Shape (per day):

    "breakdown": {
      "claude_code": {
        "models": {
          "<model id>": {
            "calls": int,
            "input": int, "cache_write_5m": int, "cache_write_1h": int,
            "cache_read": int, "output": int,
            "tokens": int        # == sum of the five type keys
          }
        },
        "unattributed": int      # real tokens with no per-type attribution
      },
      "codex": { ... same, minus `calls` and the cache_write_* keys ... }
    }

Design notes, because both matter downstream:

* TOKEN TYPES ARE A SHARED VOCABULARY. Both tools use the same five names
  (`input`, `cache_write_5m`, `cache_write_1h`, `cache_read`, `output`), and
  each tool emits only the subset it actually reports. That lets the cost
  engine and the UI iterate one list of billing dimensions instead of
  special-casing per tool. Every key present in a model entry is additive:
  the five type keys sum to `tokens`, and nothing is a subset of anything
  else (see the Codex nesting note in extract_codex).

* THE SHAPE IS DIFF-STABLE. This file is regenerated hourly by cron, so an
  unstable shape means permanently noisy diffs. Two rules keep it quiet: a
  model entry always carries its tool's full key set in a fixed order (a
  zero is written as 0, never omitted), and a model only appears on a day it
  was actually used. A new model is a new key under one day, not a schema
  migration -- nothing here enumerates models ahead of time.

* MISSING IS NOT ZERO. `unattributed` counts tokens that are genuinely real
  but carry no type or model attribution (see the Codex import below). Days
  from before this breakdown existed have no `breakdown` key at all, which
  is the signal for "never captured", as distinct from a breakdown of zeros.
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

# The canonical billing dimensions, in the order they are written. Shared by
# both tools and by scripts/build_daily_burn.py and data/pricing.json.
TOKEN_TYPES = (
    "input",
    "cache_write_5m",
    "cache_write_1h",
    "cache_read",
    "output",
)

# Claude Code reports all five; Codex reports no cache writes (see below).
CLAUDE_CODE_TYPES = TOKEN_TYPES
CODEX_TYPES = ("input", "cache_read", "output")


def local_date(iso_ts: str) -> str:
    ts = iso_ts.replace("Z", "+00:00")
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ).strftime("%Y-%m-%d")


def _new_model_bucket():
    """One model's counters for one day: {token type: count}."""
    return defaultdict(int)


def _new_model_map():
    """One day's models: {model id: counters}."""
    return defaultdict(_new_model_bucket)


def _day_models():
    """day -> model -> {token type: count}."""
    return defaultdict(_new_model_map)


def extract_claude_code():
    """Per-day exact tokens, API call counts and per-model type splits.

    Source: ~/.claude/projects/**/*.jsonl, `assistant` entries, `message.usage`.

    `message.usage` carries the four headline fields plus a `cache_creation`
    sub-object splitting cache writes into `ephemeral_5m_input_tokens` and
    `ephemeral_1h_input_tokens`. That split is worth having: a 1-hour write
    bills at 2x base input against 1.25x for a 5-minute one, and this dataset
    is ~94% 1-hour writes, so collapsing them would materially misprice the
    result. The two sub-fields were verified to sum to
    `cache_creation_input_tokens` on all 6,338 calls in the local logs.

    If the sub-object is ever absent, the whole cache-creation figure falls
    back to `cache_write_5m` -- the cheaper of the two, so an unknown split
    under-claims cost rather than inflating it.

    `message.model` was previously discarded. It is now the key of the
    per-model breakdown. One value is not a model: Claude Code writes
    `<synthetic>` for locally-generated assistant turns (an API error rendered
    as a message, say). All 14 such entries in the local logs carry zero
    tokens in every field, so they cost nothing -- but they are real calls, so
    they are kept rather than dropped, and priced at an explicit zero rate in
    data/pricing.json rather than silently skipped.
    """
    daily_tokens = defaultdict(int)
    daily_calls = defaultdict(int)
    day_projects = defaultdict(lambda: defaultdict(int))
    day_models = _day_models()
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

                inp = usage.get("input_tokens") or 0
                cache_read = usage.get("cache_read_input_tokens") or 0
                out = usage.get("output_tokens") or 0
                cache_write = usage.get("cache_creation_input_tokens") or 0

                detail = usage.get("cache_creation")
                if isinstance(detail, dict):
                    write_5m = detail.get("ephemeral_5m_input_tokens") or 0
                    write_1h = detail.get("ephemeral_1h_input_tokens") or 0
                    # Trust the headline field; assign any residual to the
                    # cheaper bucket so the split can never over-claim.
                    residual = cache_write - (write_5m + write_1h)
                    if residual:
                        write_5m += residual
                else:
                    write_5m, write_1h = cache_write, 0
                if write_5m < 0:
                    write_5m = 0

                tokens = inp + cache_write + cache_read + out
                day = local_date(ts)
                model = message.get("model") or "<unknown>"

                daily_tokens[day] += tokens
                daily_calls[day] += 1
                day_projects[day][project] += tokens

                bucket = day_models[day][model]
                bucket["calls"] += 1
                bucket["input"] += inp
                bucket["cache_write_5m"] += write_5m
                bucket["cache_write_1h"] += write_1h
                bucket["cache_read"] += cache_read
                bucket["output"] += out

    return daily_tokens, daily_calls, day_projects, day_models


def extract_codex():
    """Per-day exact tokens and per-model type splits from ~/.codex rollouts.

    token_count events carry a cumulative running total per session.
    We attribute the *rise* in that total to the day of each event, so a
    multi-day session correctly spreads its token burn across the days
    work actually happened rather than dumping the whole accumulated
    total onto the day the session finally closed.

    The counter is tracked as a HIGH-WATER MARK: only a total above the
    highest one seen so far in the file contributes, and a total at or
    below the mark contributes nothing and does not lower the baseline.
    An earlier version instead treated a drop as a context-window reset
    and added the entire new total. A survey of the real logs (55 rollout
    files, 54 with token data, 2,137 token_count events) says that was
    both unnecessary and unsafe:

      * The cumulative total never decreased -- 0 decreases in 2,137
        events -- so the reset branch had never actually fired.
      * Events are already in timestamp order within a file (0 out-of-order
        events), so there is nothing for a sort to fix.
      * Compaction does NOT reset the counter. 27 of the 54 sessions run
        their cumulative total past model_context_window (258,400); the
        largest reaches 104,986,848, some 406x the window. Codex keeps
        accumulating for the life of the rollout and opens a new file for
        a new session, so a genuine "counter went back to zero" event is
        not a thing the format produces.

    That makes any future decrease a stale, duplicated or out-of-order
    line rather than a real reset -- and the old branch turned exactly
    that into an overcount that the append-only ledger would freeze
    forever (totals 5000 -> 2000 -> 5200 scored 10,200 against a true
    5,200). The high-water mark scores that sequence at its true 5,200
    and cannot inflate a day under any input.

    (`info.last_token_usage.total_tokens` looks like a ready-made
    per-event delta and matches the rise exactly on all 2,115 events that
    moved the counter -- but 22 events repeat a *nonzero* last_token_usage
    while the cumulative total stands still. Summing that field would
    overcount by 1,350,469 tokens, so the cumulative total stays the
    authoritative signal.)

    PER-TYPE SPLIT, AND WHY IT USES THE SAME GUARD
    ----------------------------------------------
    `info.total_token_usage` also carries `input_tokens`,
    `cached_input_tokens`, `output_tokens` and `reasoning_output_tokens`.
    These are NESTED, not additive -- verified across all 2,137 events:
    `cached_input_tokens` never exceeds `input_tokens` (0 violations) and
    `reasoning_output_tokens` never exceeds `output_tokens` (0 violations).
    So cached is a SUBSET of input, and reasoning a SUBSET of output.
    Summing all four would double-count badly. The mapping is therefore:

        cache_read = cached_input_tokens
        input      = input_tokens - cached_input_tokens   (uncached remainder)
        output     = output_tokens        (reasoning folded in; it bills at
                                           the output rate, so splitting it
                                           out would add a non-additive key
                                           for no pricing benefit)

    Every one of these is tracked with its OWN high-water mark, by the same
    rule as the total: a value at or below the mark contributes nothing and
    does not lower the baseline. A stale or replayed event therefore cannot
    inflate a per-type figure any more than it can inflate the aggregate.
    Per-event deltas were verified to preserve the nesting too (0 events
    where the cached delta exceeds the input delta, so the uncached
    remainder is never negative); it is still clamped defensively.

    `cache_write_input_tokens` appears on 244 recent events but is 0 on
    every one of them, so Codex contributes no cache-write tokens and the
    cache_write_* keys are absent from its breakdown rather than zero.

    THE 2026-06-08 IMPORT (why `unattributed` exists)
    -------------------------------------------------
    14 events -- all on 2026-06-08, within a 17-second window, one per file,
    each the only token_count event in its file -- report a nonzero
    `total_tokens` with every per-type field at 0. They are not sessions:
    the surrounding entries carry `turn_id: "external-import-turn-N"`, the
    files were written by Codex Desktop 0.137.0-alpha.4 in a bulk import
    (one 3,359-line file was written in 0.25s), and they are exactly the 14
    files in the tree with no `turn_context` model. The importer carried
    over each prior session's grand total but not its composition.

    Those 449,154 tokens are real, so they stay in `codex_tokens`. But their
    type split and their model are genuinely unknown, so they are recorded
    as `unattributed` and priced as unknown rather than being smeared across
    types or silently dropped. Any future event whose total rises by more
    than its input+output rise lands in the same bucket by the same rule.

    Model name lives at `payload.model` on `turn_context` entries
    (`session_meta` has no model field). It is read as the file is walked, so
    a session that switches models mid-run attributes each event to whatever
    was current at that point. A file with token data but no `turn_context`
    at all attributes to "<unknown>" -- currently only the 14 import files,
    whose tokens are unattributed anyway.

    Each rollout's first line is a session_meta event carrying the
    working directory (payload.cwd) the session was started in. We key
    that the same way Claude Code project directories are keyed (slashes
    replaced with dashes) so a project worked on with both tools rolls
    up under one key in day_projects for driver labeling.
    """
    daily_tokens = defaultdict(int)
    day_projects = defaultdict(lambda: defaultdict(int))
    day_models = _day_models()
    day_unattributed = defaultdict(int)
    session_dirs = [HOME / ".codex" / "sessions", HOME / ".codex" / "archived_sessions"]

    for root in session_dirs:
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            high_water = 0
            marks = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
            project = None
            model = None
            with open(path) as fh:
                for line in fh:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    payload = entry.get("payload") or {}
                    if not isinstance(payload, dict):
                        continue

                    if entry.get("type") == "session_meta" and project is None:
                        cwd = payload.get("cwd")
                        if cwd:
                            project = cwd.replace("/", "-")
                        continue

                    # turn_context announces the model in force from here on.
                    if payload.get("model"):
                        model = payload["model"]

                    if payload.get("type") != "token_count":
                        continue
                    info = payload.get("info") or {}
                    usage = info.get("total_token_usage") or {}
                    total = usage.get("total_tokens")
                    ts = entry.get("timestamp")
                    if total is None or not ts:
                        continue
                    # Only a new high-water mark contributes. A total that
                    # is flat or lower is a repeat/stale line: it adds
                    # nothing and must not drag the baseline down, or the
                    # tokens between the mark and the stale value would be
                    # counted a second time when the counter climbs again.
                    if total <= high_water:
                        continue
                    delta = total - high_water
                    high_water = total

                    # Same guard, applied per type.
                    typed = {}
                    for field in marks:
                        value = usage.get(field) or 0
                        typed[field] = max(0, value - marks[field])
                        marks[field] = max(marks[field], value)

                    cache_read = min(typed["cached_input_tokens"], typed["input_tokens"])
                    uncached_input = typed["input_tokens"] - cache_read
                    output = typed["output_tokens"]
                    # Whatever the aggregate rise does not account for -- the
                    # 2026-06-08 import, or any future event of that shape.
                    unattributed = max(0, delta - (uncached_input + cache_read + output))

                    day = local_date(ts)
                    daily_tokens[day] += delta
                    if project:
                        day_projects[day][project] += delta
                    if unattributed:
                        day_unattributed[day] += unattributed

                    bucket = day_models[day][model or "<unknown>"]
                    bucket["input"] += uncached_input
                    bucket["cache_read"] += cache_read
                    bucket["output"] += output

    return daily_tokens, day_projects, day_models, day_unattributed


def tool_breakdown(models: dict, types: tuple, unattributed: int = 0,
                   with_calls: bool = False) -> dict:
    """Render one tool's per-model counts into the committed shape.

    Keys are written in a fixed order (models sorted, type keys in
    TOKEN_TYPES order) so the hourly cron produces byte-identical output for
    unchanged days. Zeros are written explicitly rather than omitted, so a
    model's key set never wobbles between runs. A model that contributed
    nothing at all -- no tokens and no calls -- is dropped, so an empty tool
    renders as an empty `models` map rather than a row of noise.
    """
    out = {}
    for model in sorted(models):
        counts = models[model]
        entry = {}
        if with_calls:
            entry["calls"] = counts.get("calls", 0)
        total = 0
        for token_type in types:
            value = counts.get(token_type, 0)
            entry[token_type] = value
            total += value
        entry["tokens"] = total
        if total or entry.get("calls"):
            out[model] = entry
    return {"models": out, "unattributed": unattributed}


def main():
    cc_tokens, cc_calls, day_projects, cc_models = extract_claude_code()
    codex_tokens, codex_day_projects, codex_models, codex_unattributed = extract_codex()

    for day, projects in codex_day_projects.items():
        for project, tokens in projects.items():
            day_projects[day][project] += tokens

    all_days = sorted(set(cc_tokens) | set(codex_tokens))
    rows = []
    for day in all_days:
        rows.append(
            {
                "date": day,
                "codex_tokens": codex_tokens.get(day, 0),
                "claude_code_tokens": cc_tokens.get(day, 0),
                "claude_code_calls": cc_calls.get(day, 0),
                "breakdown": {
                    "claude_code": tool_breakdown(
                        cc_models.get(day, {}), CLAUDE_CODE_TYPES, with_calls=True
                    ),
                    "codex": tool_breakdown(
                        codex_models.get(day, {}),
                        CODEX_TYPES,
                        unattributed=codex_unattributed.get(day, 0),
                    ),
                },
            }
        )

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

    by_type = defaultdict(int)
    for row in rows:
        for tool in row["breakdown"].values():
            for entry in tool["models"].values():
                for token_type in TOKEN_TYPES:
                    by_type[token_type] += entry.get(token_type, 0)
    typed_total = sum(by_type.values())
    for token_type in TOKEN_TYPES:
        share = (by_type[token_type] / typed_total * 100) if typed_total else 0
        print(f"  {token_type:<15} {by_type[token_type]:>15,}  {share:5.1f}%")

    unattributed = sum(r["breakdown"]["codex"]["unattributed"] for r in rows)
    if unattributed:
        days = sorted(
            r["date"] for r in rows if r["breakdown"]["codex"]["unattributed"]
        )
        print(
            f"  unattributed    {unattributed:>15,}         "
            f"(real tokens, no per-type split; days: {', '.join(days)})"
        )
    print(f"wrote {OUT_DIR / 'exact-daily.json'} and {PRIVATE_DIR / 'day-detail.json'}")


if __name__ == "__main__":
    main()
