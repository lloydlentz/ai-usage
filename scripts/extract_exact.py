#!/usr/bin/env python3
"""Extract exact daily token usage from local Claude Code and Codex logs.

Outputs:
  data/exact-daily.json   - scrubbed daily totals (safe to feed the dashboard)
  data/private/day-detail.json - per-project breakdown for driver labeling,
                                 combining both Claude Code (keyed by project
                                 directory) and Codex (keyed by session cwd)
                                 usage. Stays local; never ship or deploy this
                                 file.
  data/private/thread-daily.json - the same exact counts per conversation
                                 thread, with titles. build_daily_burn.py
                                 reconciles it with the ledger and publishes
                                 the result as data/threads.json.

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

import hashlib
import json
import sqlite3
from collections import defaultdict
from contextlib import closing
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


def _instant(iso_ts: str) -> datetime:
    """Parse a log timestamp; a naive one is taken to be UTC."""
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def local_date(iso_ts: str) -> str:
    return _instant(iso_ts).astimezone(TZ).strftime("%Y-%m-%d")


def _is_counter_restart(total: int, last_total: int | None, mark: int,
                        when: datetime, latest: datetime | None) -> bool:
    """Is this Codex token_count event a fresh counter rather than a stale line?

    A restarted counter holds exactly one response, so its cumulative total
    equals the same event's `last_token_usage` total. Nothing else has that
    shape: an advancing event mid-segment totals mark + last with a positive
    mark, a flat repeat sits at the mark, and a replayed line carries a
    timestamp older than one already seen. See extract_codex.
    """
    return (
        mark > 0
        and total > 0
        and total == last_total
        and total != mark
        and (latest is None or when >= latest)
    )


def _new_model_bucket():
    """One model's counters for one day: {token type: count}."""
    return defaultdict(int)


def _new_model_map():
    """One day's models: {model id: counters}."""
    return defaultdict(_new_model_bucket)


def _day_models():
    """day -> model -> {token type: count}."""
    return defaultdict(_new_model_map)


def thread_key(tool: str, session_id: str) -> str:
    """Stable, opaque key for one conversation thread.

    The raw session id is never published. A short hash of it is stable
    across runs, which is all build_daily_burn needs to freeze a thread's days.
    """
    prefix = {"claude_code": "cc", "codex": "cx"}[tool]
    return f"{prefix}-{hashlib.sha1(session_id.encode()).hexdigest()[:12]}"


def _clean_title(value) -> str | None:
    """A title on one line, capped; None when there is nothing to show."""
    if not isinstance(value, str):
        return None
    return " ".join(value.split())[:120] or None


def _new_thread_day():
    return {"models": _new_model_map(), "unattributed": 0}


def _thread(threads: dict, tool: str, session_id: str) -> dict:
    """The collector entry for one thread, created on first use."""
    return threads.setdefault(
        thread_key(tool, session_id),
        {"tool": tool, "title": None, "days": defaultdict(_new_thread_day)},
    )


def _codex_thread(threads: dict, meta: dict, session_id: str) -> dict:
    """A Codex rollout's thread: its own, or its parent's for a sub-agent."""
    title, parent = meta.get(session_id, (None, None))
    if parent:
        session_id, title = parent, meta.get(parent, (None, None))[0]
    thread = _thread(threads, "codex", session_id)
    thread["title"] = thread["title"] or title
    return thread


def _codex_thread_meta() -> dict:
    """{session id: (title, parent id)} from Codex's own thread records.

    Codex keeps thread names in its state database (`threads.name` for a
    rename, `threads.title` otherwise) and, for older threads, in
    session_index.jsonl. Both are optional: a missing, locked or reshaped
    database costs the titles, never a token. A sub-agent thread records its
    parent in `source`, and its tokens roll into the parent's thread -- the
    way Claude Code's sub-agent transcripts sit inside their session.
    """
    meta = {}
    index = HOME / ".codex" / "session_index.jsonl"
    if index.exists():
        for line in index.open():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and entry.get("id"):
                meta[entry["id"]] = (_clean_title(entry.get("thread_name")), None)

    databases = [
        path for path in (HOME / ".codex").glob("state_*.sqlite")
        if path.stem.rpartition("_")[2].isdigit()
    ]
    if not databases:
        return meta
    database = max(databases, key=lambda path: int(path.stem.rpartition("_")[2]))
    try:
        with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as db:
            records = db.execute("select id, name, title, source from threads").fetchall()
    except sqlite3.Error:
        return meta
    for thread_id, name, title, source in records:
        parent = None
        if isinstance(source, str) and source.startswith("{"):
            try:
                parent = json.loads(source)["subagent"]["thread_spawn"]["parent_thread_id"]
            except (KeyError, TypeError, json.JSONDecodeError):
                parent = None
        indexed = meta.get(thread_id, (None, None))[0]
        meta[thread_id] = (_clean_title(name) or _clean_title(title) or indexed, parent)
    return meta


def extract_claude_code(threads: dict | None = None):
    """Per-day exact tokens, API call counts and per-model type splits.

    Pass a dict as `threads` to collect the same counts per conversation as
    well: a session and its sub-agent transcripts are one thread, titled by
    its latest rename, else by Claude's own summary title.

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
    titles = defaultdict(dict)
    root = HOME / ".claude" / "projects"

    # Sorted, so the transcript that claims a replayed call (see `seen`) is the
    # same on every run and a thread's share of a day does not flap hourly.
    for path in sorted(root.rglob("*.jsonl")):
        # <project>/<session>.jsonl, or <project>/<session>/subagents/*.jsonl
        # for a sub-agent's transcript, which belongs to its session's thread.
        parts = path.relative_to(root).parts
        project = parts[0]
        session_id = parts[1] if len(parts) > 2 else path.stem
        with open(path) as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = entry.get("type")
                if kind in ("custom-title", "ai-title"):
                    # A rename (custom-title) outranks Claude's own summary
                    # (ai-title); within each kind the latest line wins.
                    title = _clean_title(entry.get("customTitle" if kind == "custom-title" else "aiTitle"))
                    if title:
                        titles[session_id][kind] = title
                    continue
                if kind != "assistant":
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

                buckets = [day_models[day][model]]
                if threads is not None:
                    buckets.append(_thread(threads, "claude_code", session_id)["days"][day]["models"][model])
                for bucket in buckets:
                    bucket["calls"] += 1
                    bucket["input"] += inp
                    bucket["cache_write_5m"] += write_5m
                    bucket["cache_write_1h"] += write_1h
                    bucket["cache_read"] += cache_read
                    bucket["output"] += out

    if threads is not None:
        for session_id, found in titles.items():
            thread = threads.get(thread_key("claude_code", session_id))
            if thread is not None:
                thread["title"] = found.get("custom-title") or found.get("ai-title")
    return daily_tokens, daily_calls, day_projects, day_models


def extract_codex(threads: dict | None = None):
    """Per-day exact tokens and per-model type splits from ~/.codex rollouts.

    Pass a dict as `threads` to collect the same counts per conversation as
    well (see _codex_thread_meta for titles and sub-agent threads).

    token_count events carry a cumulative running total per session.
    We attribute the *rise* in that total to the day of each event, so a
    multi-day session correctly spreads its token burn across the days
    work actually happened rather than dumping the whole accumulated
    total onto the day the session finally closed.

    COUNTER SEGMENTS: RESTARTS VERSUS STALE LINES
    ---------------------------------------------
    Within a run of the counter, the total is tracked as a HIGH-WATER MARK:
    only a total above the highest one seen so far contributes, and a total
    at or below the mark contributes nothing and does not lower the
    baseline. An earlier version read every drop as a context-window reset
    and added the entire new total, which turns a stale or replayed line
    into an overcount the append-only ledger freezes forever (totals
    5000 -> 2000 -> 5200 scored 10,200 against a true 5,200).

    The July 2026 survey behind the mark (55 rollout files, 2,137
    token_count events) found the total never decreased and events were
    always in timestamp order, so the mark alone was enough. It no longer
    is: newer Codex Desktop builds RESTART the counter mid-session. A
    September 12, 2026 survey of 170 rollouts found 38 restarts in 21 of
    them, with daily impact from 2026-08-27. What triggers one is not
    recorded (they happen in rollouts with no compaction at all). The bare
    mark ignored every token after a restart until the counter climbed
    past the old peak, which it rarely does: 266.6M tokens, 24.7% of all
    Codex usage, went uncounted. Codex's own state database shows the same
    symptom from the other side -- `threads.tokens_used` holds only the
    running total since the last restart, so it is no per-thread total
    either.

    A restart has an exact signature that a stale line does not share. A
    fresh counter holds one response, so its total equals the same event's
    `last_token_usage.total_tokens` -- true of all 38, with every per-type
    field matching too. An advancing event mid-segment never has that shape
    (its total is mark + last, and the mark is positive); a flat repeat
    sits at the mark; a replayed line carries a timestamp older than one
    already seen. `_is_counter_restart` encodes exactly that. A restart
    closes the segment: the total mark and every per-type mark return to
    zero together and the event counts as a rise from zero, so a session
    contributes the sum of its segments' peaks. Any other drop is still a
    stale line. Two real cases pin the rule down: back-to-back restarts
    where the second single response is the larger (44,399 then 46,059;
    Codex's own response records confirm both), and a restart line written
    twice (111,014, 111,014), which contributes once.

    (`info.last_token_usage.total_tokens` looks like a ready-made
    per-event delta and matches the rise on every event that moves the
    counter -- but some events repeat a *nonzero* last_token_usage while
    the cumulative total stands still (22 in the July survey, overcounting
    by 1,350,469 tokens if summed). So the cumulative total stays the
    authoritative signal, and `last` is read only to recognise a restart.)

    WHY token_count RATHER THAN token_usage_record
    ----------------------------------------------
    About 30 recent rollouts also carry `token_usage_record` rows: one per
    model response, keyed by `response_id`, with a monotonic
    `thread_token_usage`. They corroborate the restart rule --
    restart-aware token_count never exceeds them in any file -- and run
    7,980,349 tokens (0.6%) higher overall. Every record token_count lacks
    sits immediately before a `compacted` entry: those are the
    context-compaction calls, which token_count never reports. token_count
    remains the authority regardless. It is the only counter in older
    rollouts, it carries the per-type split this function validates, and
    choosing a source per file would make the ledger's meaning depend on
    which Codex version wrote each log. Never add records on top of
    token_count; the uncounted compaction calls are a known, documented
    undercount.

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
    does not lower the baseline, and all of them return to zero together
    at a counter restart. A stale or replayed event therefore cannot
    inflate a per-type figure any more than it can inflate the aggregate.
    The original July survey found per-event deltas preserved nesting (0 events
    where the cached delta exceeds the input delta, so the uncached
    remainder is never negative); it is still clamped defensively.

    A September 10, 2026 audit found seven advancing events across August 27,
    September 1, 5, 6, 8 and 9 whose type deltas violated either the total or
    cached-input nesting, quarantined their splits as unattributed, and
    rebuilt the six captured days with --repair-codex-days (complete
    aggregate coverage, private backups). Those seven -- and three later
    ones -- were counter restarts read against the previous segment's
    marks. With segment-aware marks every one of them splits cleanly, and
    no event in the real logs is ambiguous. The quarantine stays for
    anything that still disagrees: never proportionally invent a type
    split, and a split/total disagreement stops the ledger build rather
    than freezing an inflated split.

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
    restarts = restarted_files = 0
    codex_meta = _codex_thread_meta() if threads is not None else {}
    session_dirs = [HOME / ".codex" / "sessions", HOME / ".codex" / "archived_sessions"]

    for root in session_dirs:
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            # The marks belong to the current counter segment. `latest` is
            # the newest event time seen, so a back-dated line can never pose
            # as a restart.
            high_water = 0
            marks = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
            latest = None
            file_restarts = 0
            project = None
            model = None
            session_id = None
            thread = None
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
                        session_id = session_id or payload.get("id") or payload.get("session_id")
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
                    when = _instant(ts)
                    last_total = (info.get("last_token_usage") or {}).get("total_tokens")
                    if _is_counter_restart(total, last_total, high_water, when, latest):
                        # A fresh counter closes the segment. Every mark
                        # returns to zero together, so this event's whole
                        # total -- one response -- counts as the new
                        # segment's first rise.
                        high_water = 0
                        marks = dict.fromkeys(marks, 0)
                        file_restarts += 1
                    latest = when if latest is None else max(latest, when)
                    # Within a segment only a new high-water mark
                    # contributes. A total that is flat or lower is a
                    # repeat/stale line: it adds nothing and must not drag
                    # the baseline down, or the tokens between the mark and
                    # the stale value would be counted a second time when
                    # the counter climbs again.
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

                    # Independent per-type marks must never manufacture a
                    # split larger than the authoritative total. The
                    # September 2026 disagreements were restarts read against
                    # the previous segment's marks; anything that still
                    # disagrees keeps its total and quarantines just this
                    # event's split.
                    ambiguous = (
                        typed["input_tokens"] + typed["output_tokens"] > delta
                        or typed["cached_input_tokens"] > typed["input_tokens"]
                        or (usage.get("cache_write_input_tokens") or 0) > 0
                    )
                    if ambiguous:
                        print(f"  attribution: {local_date(ts)} Codex event has inconsistent or unsupported type counters; {delta} tokens kept unattributed")
                        typed = {field: 0 for field in marks}
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

                    buckets = [day_models[day][model or "<unknown>"]]
                    if threads is not None:
                        if thread is None:
                            thread = _codex_thread(threads, codex_meta, session_id or path.stem)
                        thread_day = thread["days"][day]
                        thread_day["unattributed"] += unattributed
                        buckets.append(thread_day["models"][model or "<unknown>"])
                    for bucket in buckets:
                        bucket["input"] += uncached_input
                        bucket["cache_read"] += cache_read
                        bucket["output"] += output
            if file_restarts:
                restarts += file_restarts
                restarted_files += 1

    if restarts:
        print(f"  codex: {restarts} counter restarts in {restarted_files} rollouts, each counted as a new segment")
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
    threads = {}
    cc_tokens, cc_calls, day_projects, cc_models = extract_claude_code(threads)
    codex_tokens, codex_day_projects, codex_models, codex_unattributed = extract_codex(threads)

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

    # The same counts per thread, titles included. build_daily_burn.py
    # reconciles this with the ledger before anything is published.
    thread_rows = [
        {
            "key": key,
            "tool": thread["tool"],
            "title": thread["title"],
            "days": {
                day: tool_breakdown(
                    counts["models"],
                    CLAUDE_CODE_TYPES if thread["tool"] == "claude_code" else CODEX_TYPES,
                    unattributed=counts["unattributed"],
                    with_calls=thread["tool"] == "claude_code",
                )
                for day, counts in sorted(thread["days"].items())
            },
        }
        for key, thread in sorted(threads.items())
    ]
    with open(PRIVATE_DIR / "thread-daily.json", "w") as fh:
        json.dump(thread_rows, fh, indent=2)

    # This clock is independent of repricing/building the ledger. Never claim
    # a fresh collection merely because build_daily_burn ran again.
    collection = {
        "collected_at": datetime.now(TZ).isoformat(timespec="seconds"),
        "sources_available": {
            "claude_code": (HOME / ".claude/projects").is_dir(),
            "codex": any((HOME / ".codex" / folder).is_dir() for folder in ("sessions", "archived_sessions")),
        },
    }
    (PRIVATE_DIR / "collection.json").write_text(json.dumps(collection))

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
    codex_threads = sum(1 for thread in thread_rows if thread["tool"] == "codex")
    print(f"  threads         {len(thread_rows):>15,}         ({len(thread_rows) - codex_threads} Claude Code, {codex_threads} Codex)")
    print(f"wrote {OUT_DIR / 'exact-daily.json'}, {PRIVATE_DIR / 'day-detail.json'} and {PRIVATE_DIR / 'thread-daily.json'}")


if __name__ == "__main__":
    main()
