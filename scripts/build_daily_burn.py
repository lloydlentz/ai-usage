#!/usr/bin/env python3
"""Merge exact daily usage with labeled estimates into data/daily-burn.json.

Strategy: additive / append-only ledger.
  - Any row already in daily-burn.json that has nonzero exact data keeps
    its captured counts: each exact column takes the max of the captured
    value and the freshly extracted one. That covers the day disappearing
    from the logs *and* the day merely coming back thinner than before.
  - A captured value that survives a smaller extracted one is logged, so
    a genuine downward correction is visible rather than silently blocked;
    to accept one, edit the value in daily-burn.json by hand.
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

Per-type breakdown and cost
---------------------------
Each row carries, in addition to the aggregate columns:

  * `breakdown` — the per-tool, per-model, per-token-type split produced by
    extract_exact.py. See that module for the shape and for why the four
    Claude token types cannot be summed at equal weight.
  * `cost_usd` — what the day's usage would have cost at API list prices.

COST IS A COUNTERFACTUAL, NOT AN INVOICE. This usage was almost certainly
incurred on flat-rate subscriptions (Claude Max, ChatGPT), not on metered
API billing. `cost_usd.basis` says so in the data itself, and ESTIMATES.md
says so in prose. Nothing here should be rendered as money that was spent.

FREEZING AND DERIVED VALUES. The append-only guarantee protects
*measurements*, not *derivations*. Token counts — including every leaf of
the breakdown — are held at a per-column high-water mark and can never
shrink. Cost is recomputed from those counts and data/pricing.json on every
run, so correcting a rate reprices the whole ledger, which is the point of
keeping the rate card in an editable file.

WHAT "FROZEN" MEANS FOR A COLUMN THAT DID NOT EXIST. A row captured before
the breakdown existed has no `breakdown` key at all. Absent is not zero:

  * previous row has no breakdown, extraction has one  -> write it (new
    information about an old day, which is additive and therefore allowed)
  * previous row has one, extraction has none (logs pruned) -> keep the
    captured breakdown verbatim; never overwrite it with zeros
  * both present -> per-leaf max, same rule as the aggregates, and any
    preserved leaf is logged
  * extraction finds a model the captured row never saw -> add it

and a row that never had one and cannot get one (its logs are long gone)
keeps no `breakdown` key, so the UI can tell "no split was ever captured"
apart from "the split is all zeros".
"""
from __future__ import annotations  # allow X | Y union syntax on Python 3.9

import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
# Anchored to ROOT rather than DATA: the rate card is a committed source file,
# not pipeline output, so tests that redirect DATA at a temp directory still
# get the real rates. Pass `rates=` or patch this to override.
PRICING_PATH = ROOT / "data" / "pricing.json"

RANGE_START = date(2026, 5, 4)  # first day with exact logs

# Estimate patterns (tokens per day, by weekday number Mon=0..Sun=6).
# See ESTIMATES.md for the reasoning behind each number.
CLAUDE_CHAT_EST = {0: 30_000, 1: 30_000, 2: 30_000, 3: 30_000, 4: 30_000}
CHATGPT_EST = {0: 15_000, 2: 15_000, 4: 15_000}
GEMINI_EST = {0: 8_000, 1: 50_000, 3: 50_000, 4: 8_000}

# Billing dimensions, in write order. Mirrors extract_exact.TOKEN_TYPES and
# the keys under each model in data/pricing.json.
TOKEN_TYPES = (
    "input",
    "cache_write_5m",
    "cache_write_1h",
    "cache_read",
    "output",
)

# The tools that own a sub-map inside `breakdown`, paired with the exact
# column each one's tokens roll up into.
BREAKDOWN_TOOLS = {
    "claude_code": "claude_code_tokens",
    "codex": "codex_tokens",
}

COST_BASIS = "api_list_price_counterfactual"

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
    "2026-06-18": ("research", "evaluating Codex (exact logs)"),
    "2026-06-19": ("research", "second coding agent evaluation (exact logs)"),
    "2026-06-30": ("shipping", "web portal work (exact logs)"),
    "2026-07-01": ("shipping", "web portal work (exact logs)"),
    "2026-07-02": ("shipping", "web app feature work (exact logs)"),
    "2026-07-03": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-04": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-05": ("shipping", "web app feature work (exact logs)"),
    "2026-07-06": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-07": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-08": ("shipping", "web app feature work (exact logs)"),
    "2026-07-09": ("shipping", "web app feature work (exact logs)"),
    "2026-07-10": ("shipping", "web app feature work (exact logs)"),
    "2026-07-11": ("admin", "ad hoc scripting (exact logs)"),
    "2026-07-12": ("shipping", "web app feature work (exact logs)"),
    "2026-07-13": ("shipping", "web app feature work (exact logs)"),
    "2026-07-14": ("shipping", "web app feature work (exact logs)"),
    "2026-07-15": ("shipping", "web app feature work (exact logs)"),
    "2026-07-16": ("research", "dashboard redesign work (exact logs)"),
    "2026-07-17": ("shipping", "web app feature work (exact logs)"),
    "2026-07-18": ("research", "dashboard redesign work (exact logs)"),
    "2026-07-19": ("shipping", "admissions AI project work (exact logs)"),
    "2026-07-20": ("shipping", "heavy web app build day (exact logs)"),
    "2026-07-21": ("research", "dashboard redesign work (exact logs)"),
    "2026-07-22": ("shipping", "web app feature work (exact logs)"),
    "2026-07-23": ("shipping", "web app feature work (exact logs)"),
    "2026-07-24": ("shipping", "web app feature work (exact logs)"),
    "2026-07-25": ("research", "dashboard redesign work (exact logs)"),
    "2026-07-26": ("shipping", "web app feature work (exact logs)"),
    "2026-07-27": ("shipping", "web portal work (exact logs)"),
}

CHAT_ONLY = ("research", "chat-only day; all values estimated")


def load_existing(path: Path) -> dict:
    """Load existing daily-burn.json keyed by date, or {} if absent."""
    if not path.exists():
        return {}
    with open(path) as fh:
        rows = json.load(fh)
    return {r["date"]: r for r in rows}


def load_pricing(path: Path | None = None) -> dict:
    """Load data/pricing.json into {model id: {token type: usd per 1M}}.

    Aliases are resolved here so callers never have to know about them, and
    a missing file yields an empty table -- which prices *everything* as
    unknown and warns loudly, rather than pricing everything at zero.
    """
    path = path or PRICING_PATH
    if not path.exists():
        return {}
    with open(path) as fh:
        raw = json.load(fh)
    rates = {
        model: dict(entry.get("usd_per_million") or {})
        for model, entry in (raw.get("models") or {}).items()
    }
    for alias, target in (raw.get("aliases") or {}).items():
        if target in rates:
            rates[alias] = rates[target]
    return rates


def has_exact_data(row: dict) -> bool:
    return (row.get("codex_tokens") or 0) + (row.get("claude_code_tokens") or 0) > 0


EXACT_COLUMNS = ("codex_tokens", "claude_code_tokens", "claude_code_calls")


def exact_count(row: dict, column: str) -> int:
    """Read an exact column, tolerating a missing key or a null value.

    Rows in daily-burn.json go back to hand-edited and older-schema
    versions of this script, so indexing a column directly is how the
    hourly cron dies with a KeyError.
    """
    return (row or {}).get(column) or 0


def reconcile_exact(key: str, ex: dict, prev_exact: dict | None) -> dict:
    """Merge freshly extracted counts with previously captured ones.

    The ledger is append-only because the source logs get pruned, so a
    captured count is never allowed to shrink: each column takes the
    max of what was captured before and what extraction just found.
    Guarding only on "the day vanished from exact-daily.json" was not
    enough -- partial log pruning, a dedup regression or a log-schema
    change leaves the day present but under-counted, and the smaller
    number would quietly overwrite history.

    max() also blocks *legitimate* downward corrections, so it is never
    silent: every preserved column prints a line naming the date, the
    column and both values. That lands in the cron log
    (/tmp/token-burn-refresh.log), and the escape hatch for a genuine
    correction is to edit the value in data/daily-burn.json by hand --
    the next run sees the lower captured value and keeps it.
    """
    merged = {}
    for column in EXACT_COLUMNS:
        fresh = exact_count(ex, column)
        captured = exact_count(prev_exact, column)
        if captured > fresh:
            print(
                f"  ledger: {key} {column} keeps captured {captured:,} over "
                f"extracted {fresh:,} (extraction under-counted; edit "
                f"data/daily-burn.json by hand to accept a lower value)"
            )
            merged[column] = captured
        else:
            merged[column] = fresh
    return merged


def _model_entry_types(entry: dict) -> tuple:
    """The token-type keys a model entry actually carries, in canonical order.

    Codex entries omit the cache_write_* keys entirely (Codex reports no
    cache-write tokens), so the key set is per-tool and read off the data
    rather than assumed.
    """
    return tuple(t for t in TOKEN_TYPES if t in entry)


def _merge_model_entry(key: str, tool: str, model: str,
                       fresh: dict | None, captured: dict | None) -> dict:
    """Per-leaf high-water mark for one model's counts."""
    fresh = fresh or {}
    captured = captured or {}
    types = _model_entry_types(fresh) or _model_entry_types(captured)
    merged = {}
    if "calls" in fresh or "calls" in captured:
        merged["calls"] = max(fresh.get("calls") or 0, captured.get("calls") or 0)
    total = 0
    for token_type in types:
        f = fresh.get(token_type) or 0
        c = captured.get(token_type) or 0
        if c > f:
            print(
                f"  ledger: {key} breakdown.{tool}.{model}.{token_type} keeps "
                f"captured {c:,} over extracted {f:,} (extraction "
                f"under-counted; edit data/daily-burn.json by hand to accept "
                f"a lower value)"
            )
        value = max(f, c)
        merged[token_type] = value
        total += value
    merged["tokens"] = total
    return merged


def reconcile_breakdown(key: str, fresh: dict | None,
                        captured: dict | None) -> dict | None:
    """Merge a freshly extracted breakdown with a previously captured one.

    Absence is meaningful on both sides and is never treated as zero:
    a missing captured breakdown means the day predates the split (so the
    fresh one is written as new information), and a missing fresh one means
    the logs are gone (so the captured one survives verbatim).
    """
    if not fresh:
        return captured or None
    if not captured:
        return fresh

    merged = {}
    for tool in sorted(set(fresh) | set(captured)):
        f_tool = fresh.get(tool) or {}
        c_tool = captured.get(tool) or {}
        f_models = f_tool.get("models") or {}
        c_models = c_tool.get("models") or {}
        models = {}
        for model in sorted(set(f_models) | set(c_models)):
            models[model] = _merge_model_entry(
                key, tool, model, f_models.get(model), c_models.get(model)
            )
        merged[tool] = {
            "models": models,
            "unattributed": max(
                f_tool.get("unattributed") or 0, c_tool.get("unattributed") or 0
            ),
        }
    return merged


def reconcile_unattributed(key: str, breakdown: dict | None, merged: dict) -> None:
    """Make every tool's breakdown add up to its aggregate column, in place.

    Invariant, asserted by the test suite:

        sum(model["tokens"]) + unattributed == <tool aggregate column>

    `unattributed` is the honest residual. It picks up two real cases: the
    2026-06-08 Codex import, whose tokens are real but carry no per-type or
    per-model split (see extract_exact.extract_codex), and any day whose
    aggregate was frozen from a capture that predates the breakdown, so the
    split covers less than the headline. Without this the UI could render a
    breakdown that quietly under-reports the number next to it.
    """
    if not breakdown:
        return
    for tool, column in BREAKDOWN_TOOLS.items():
        entry = breakdown.get(tool)
        if entry is None:
            continue
        typed = sum(m.get("tokens") or 0 for m in (entry.get("models") or {}).values())
        aggregate = merged.get(column) or 0
        if typed > aggregate:
            # Never observed: both sides take a max of the same source. If it
            # ever fires the breakdown and the headline disagree, so say so
            # rather than quietly reshaping one of them.
            print(
                f"  WARNING: {key} breakdown.{tool} sums to {typed:,} but "
                f"{column} is {aggregate:,}; the split exceeds its aggregate"
            )
        entry["unattributed"] = max(0, aggregate - typed)


def price_breakdown(breakdown: dict | None, rates: dict) -> tuple[dict, dict]:
    """Cost a day's breakdown, and mutate each model entry with its own cost.

    Returns (cost_usd, unpriced) where `unpriced` maps an unknown model id to
    the token count it accounts for, so the caller can warn by model and day.

    An unknown model is priced as UNKNOWN, never as zero: its entry's
    `cost_usd` is null and its tokens land in `cost_usd.unpriced_tokens`.
    `unattributed` tokens are unpriced by definition -- there is no type
    split to apply a rate to -- and are counted there too, under the
    reserved key "<unattributed>".
    """
    cost = {
        "basis": COST_BASIS,
        "total": 0.0,
        # Both tools always appear, so the UI never has to test for a key.
        "by_tool": {tool: 0.0 for tool in sorted(BREAKDOWN_TOOLS)},
        "by_type": {t: 0.0 for t in TOKEN_TYPES},
        "unpriced_tokens": 0,
    }
    unpriced: dict[str, int] = {}
    if not breakdown:
        return cost, unpriced

    total = 0.0
    by_type = defaultdict(float)
    for tool in sorted(breakdown):
        entry = breakdown[tool] or {}
        tool_cost = 0.0
        for model, counts in (entry.get("models") or {}).items():
            model_rates = rates.get(model)
            if model_rates is None:
                counts["cost_usd"] = None
                tokens = counts.get("tokens") or 0
                cost["unpriced_tokens"] += tokens
                unpriced[model] = unpriced.get(model, 0) + tokens
                continue
            model_cost = 0.0
            for token_type in _model_entry_types(counts):
                rate = model_rates.get(token_type)
                if rate is None:
                    # A type the model has no published rate for (e.g. an
                    # Anthropic cache-write rate on an OpenAI model). Only
                    # reachable with a nonzero count if the log schema
                    # changes; treat it as unpriced rather than free.
                    tokens = counts.get(token_type) or 0
                    if tokens:
                        cost["unpriced_tokens"] += tokens
                        unpriced[f"{model}:{token_type}"] = (
                            unpriced.get(f"{model}:{token_type}", 0) + tokens
                        )
                    continue
                amount = (counts.get(token_type) or 0) * rate / 1_000_000
                model_cost += amount
                by_type[token_type] += amount
            counts["cost_usd"] = round(model_cost, 6)
            tool_cost += model_cost
            total += model_cost
        cost["by_tool"][tool] = round(tool_cost, 6)
        unattributed = entry.get("unattributed") or 0
        if unattributed:
            cost["unpriced_tokens"] += unattributed
            unpriced["<unattributed>"] = (
                unpriced.get("<unattributed>", 0) + unattributed
            )

    cost["total"] = round(total, 6)
    cost["by_type"] = {t: round(by_type[t], 6) for t in TOKEN_TYPES}
    return cost, unpriced


def build_row(key: str, ex: dict, prev_exact: dict | None,
              rates: dict | None = None,
              unpriced_out: dict | None = None) -> dict:
    """Build one ledger row.

    `unpriced_out`, when given, accumulates {model: {date: tokens}} for every
    model this row could not price, so main() can warn once per model across
    all affected days rather than once per row.
    """
    wd = date.fromisoformat(key).weekday()
    claude_chat = CLAUDE_CHAT_EST.get(wd, 0)
    chatgpt = CHATGPT_EST.get(wd, 0)
    gemini = GEMINI_EST.get(wd, 0)

    merged = reconcile_exact(key, ex, prev_exact)
    codex = merged["codex_tokens"]
    claude_code = merged["claude_code_tokens"]
    calls = merged["claude_code_calls"]

    if key in DRIVERS:
        driver, evidence = DRIVERS[key]
    elif codex or claude_code:
        driver, evidence = "unlabeled", "exact logs; add a driver label for this day"
    else:
        driver, evidence = CHAT_ONLY

    row = {
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

    breakdown = reconcile_breakdown(
        key, (ex or {}).get("breakdown"), (prev_exact or {}).get("breakdown")
    )
    reconcile_unattributed(key, breakdown, merged)

    # `cost_usd` is present on exactly the rows that have exact tokens, so its
    # absence has one unambiguous meaning: the day had no measured usage at
    # all (estimates only), and there is nothing to cost. A day that *does*
    # have tokens but no breakdown -- captured before the split existed, logs
    # since pruned -- still gets a cost_usd, reporting the whole aggregate as
    # unpriced. Otherwise "no cost_usd" would mean "$0" on some rows and
    # "unknown" on others, and a cost dashboard cannot afford that ambiguity.
    if breakdown is None and not (codex or claude_code):
        return row

    rates = load_pricing() if rates is None else rates
    cost, unpriced = price_breakdown(breakdown, rates)
    if breakdown is not None:
        row["breakdown"] = breakdown
    else:
        unmeasured = codex + claude_code
        cost["unpriced_tokens"] = unmeasured
        unpriced["<no breakdown captured>"] = unmeasured
    row["cost_usd"] = cost
    if unpriced_out is not None:
        for model, tokens in unpriced.items():
            unpriced_out.setdefault(model, {})[key] = tokens
    return row


def main():
    with open(DATA / "exact-daily.json") as fh:
        exact = {row["date"]: row for row in json.load(fh)}
    out_path = DATA / "daily-burn.json"
    existing = load_existing(out_path)
    rates = load_pricing()
    if not rates:
        print(
            f"  WARNING: no rate card at {PRICING_PATH}; every model will be "
            f"reported as unpriced (cost unknown, not zero)"
        )

    # Determine range: from RANGE_START to the latest date seen in either source.
    all_dates = set(exact.keys()) | set(existing.keys())
    if not all_dates:
        print("no data found")
        return
    end = max(date.fromisoformat(d) for d in all_dates)

    rows = []
    frozen_count = 0
    new_count = 0
    unpriced_days: dict[str, dict[str, int]] = defaultdict(dict)

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

        # Carry a row's captured exact counts forward, whether the logs are
        # now gone entirely or merely thinner than they were. build_row takes
        # the per-column max and announces anything it holds on to.
        prev_exact = prev if (prev and has_exact_data(prev)) else None
        row = build_row(key, ex, prev_exact, rates=rates, unpriced_out=unpriced_days)
        if prev_exact and any(
            exact_count(prev_exact, column) > exact_count(ex, column)
            for column in EXACT_COLUMNS
        ):
            frozen_count += 1
        else:
            new_count += 1

        rows.append(row)
        day += timedelta(days=1)

    with open(out_path, "w") as fh:
        json.dump(rows, fh, indent=2)

    total_cost = round(sum((r.get("cost_usd") or {}).get("total") or 0 for r in rows), 6)
    unpriced_tokens = sum(
        (r.get("cost_usd") or {}).get("unpriced_tokens") or 0 for r in rows
    )

    now = datetime.now(ZoneInfo("America/Chicago"))
    meta = {
        "refreshed_at": now.isoformat(timespec="seconds"),
        "cost": {
            "basis": COST_BASIS,
            "disclaimer": (
                "What this usage would have cost at public API list prices. "
                "The usage was incurred on flat-rate subscriptions, not "
                "metered API billing, so this is a counterfactual and not "
                "money that was actually spent."
            ),
            "total_usd": total_cost,
            "unpriced_tokens": unpriced_tokens,
            "unpriced_models": sorted(unpriced_days),
        },
    }
    with open(DATA / "meta.json", "w") as fh:
        json.dump(meta, fh)

    print(f"wrote {len(rows)} rows  ({frozen_count} frozen from previous capture, {new_count} live/new)")
    print(f"grand total: {sum(r['total'] for r in rows):,} tokens")

    by_type = defaultdict(float)
    for row in rows:
        for token_type, amount in ((row.get("cost_usd") or {}).get("by_type") or {}).items():
            by_type[token_type] += amount
    print(f"counterfactual cost at API list prices: ${total_cost:,.2f}")
    for token_type in TOKEN_TYPES:
        share = (by_type[token_type] / total_cost * 100) if total_cost else 0
        print(f"  {token_type:<15} ${by_type[token_type]:>12,.2f}  {share:5.1f}%")

    for model in sorted(unpriced_days):
        days = unpriced_days[model]
        tokens = sum(days.values())
        listed = ", ".join(sorted(days))
        if model == "<unattributed>":
            print(
                f"  UNPRICED: {tokens:,} tokens have no per-type split and so "
                f"no cost, on {len(days)} day(s): {listed} (real tokens; "
                f"reported as unknown, never as zero)"
            )
        elif model == "<no breakdown captured>":
            print(
                f"  UNPRICED: {tokens:,} tokens were captured before the "
                f"per-type split existed and their logs are gone, on "
                f"{len(days)} day(s): {listed} (the tokens are real and "
                f"frozen; their cost is unknowable, not zero)"
            )
        else:
            print(
                f"  UNPRICED: no rate for model {model!r} -- {tokens:,} tokens "
                f"on {len(days)} day(s): {listed} (cost reported as unknown, "
                f"not zero; add an entry to {PRICING_PATH})"
            )
    print(f"refreshed_at: {meta['refreshed_at']}")


if __name__ == "__main__":
    main()
