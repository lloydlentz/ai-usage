# Estimate assumptions

Exact and estimated columns are never mixed. Exact columns come from local
logs; estimated columns come from a user interview on 2026-06-12 and the
deterministic weekday patterns below. If your habits change, update the
patterns in `scripts/build_daily_burn.py` and this file together.

## Exact sources

| Column | Source | Method |
| --- | --- | --- |
| `claude_code_tokens` | `~/.claude/projects/**/*.jsonl` | Sum of input + cache-creation + cache-read + output tokens per assistant API call, deduplicated by message/request id, bucketed by America/Chicago day. |
| `claude_code_calls` | same | Count of deduplicated assistant API calls. |
| `codex_tokens` | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl` | Each session's `token_count` events carry a cumulative `total_token_usage.total_tokens`, tracked as a **high-water mark**: only a total above the highest seen so far in that file contributes, and a flat or lower total contributes nothing without lowering the baseline. The rise is attributed to the America/Chicago day of *that* event, so a multi-day session spreads across the days work actually happened instead of dumping its whole total on the closing day. A survey of 55 rollout files / 2,137 events found 0 decreases and 0 out-of-order events, so a decrease can only be a stale or replayed line — never a counter reset. |

These three columns are measurements, not estimates, and their meaning has
not changed. Everything below is layered on top of them.

## Token types (exact, per model)

Each day's `breakdown` splits the exact tokens by tool, by model, and by
billing dimension. This exists because **the token types are not
interchangeable**, and collapsing them makes the headline number
meaningless: cache reads are ~96% of this dataset's raw token volume but
only ~56% of its cost, while 1-hour cache writes are ~3% of volume and ~32%
of cost. A long cached session inflates the raw count without more real work
happening.

| Type | Meaning | Anthropic rate | OpenAI rate |
| --- | --- | --- | --- |
| `input` | Uncached input tokens | base | base |
| `cache_write_5m` | Written to a 5-minute ephemeral cache | 1.25× input | n/a — no cache-write premium |
| `cache_write_1h` | Written to a 1-hour ephemeral cache | 2× input | n/a |
| `cache_read` | Served from prompt cache | 0.1× input | published separately |
| `output` | Output tokens | base output | base output |

**Claude Code** reports all five. The 5m/1h split comes from
`usage.cache_creation.ephemeral_{5m,1h}_input_tokens`, which was verified to
sum exactly to `cache_creation_input_tokens` on all 6,338 calls in the local
logs. *Assumption:* if that sub-object is ever missing, the whole
cache-creation figure is counted as `cache_write_5m` — the cheaper of the
two, so an unknown split under-claims cost rather than inflating it.

**Codex** reports three. Its fields are **nested, not additive**:
`cached_input_tokens` is a subset of `input_tokens`, and
`reasoning_output_tokens` a subset of `output_tokens` (0 violations across
all 2,137 real events). So `cache_read` takes the cached figure, `input`
takes the uncached remainder, and reasoning is folded into `output` because
it bills at the output rate. Summing all four fields would double-count
every cache hit. Each type carries its own high-water mark, by the same rule
as the aggregate, so a stale event cannot inflate a per-type figure either.
Codex reports no cache-write tokens (`cache_write_input_tokens` appears on
244 recent events and is 0 on every one), so its `cache_write_*` keys are
**absent rather than zero**.

## Cost — a counterfactual, not an invoice

`cost_usd` answers one question: **what would this usage have cost at public
API list prices?** It is not money that was spent. This usage was incurred on
flat-rate subscriptions (Claude Max, ChatGPT plans), not on metered API
billing, so no invoice anywhere matches this number. The data says so in
`cost_usd.basis` (`api_list_price_counterfactual`) and in
`meta.json → cost.disclaimer`; anything that renders the figure should say so
too.

Rates live in **`data/pricing.json`**, one entry per model, each with a
`source` and a `source_date`. It is a plain config file — correcting a rate
needs no code change. Cost is *derived*, never frozen: every run reprices the
whole ledger from the current rate card, so a correction propagates
backwards. (Token counts are the opposite — see the ledger rules below.)

Anthropic cache rates are computed from the documented multipliers
(read 0.1×, 5m write 1.25×, 1h write 2× of base input) rather than
transcribed, and a test asserts they stay consistent. `claude-sonnet-5` is
priced at its standard $3/$15 list rate; an introductory $2/$10 rate runs
through 2026-08-31 and would cover this entire dataset, but the durable list
price is used so the figure does not silently expire.

### Unknown models are loud, never free

A model with no entry in `pricing.json` is priced as **unknown**, not zero:
its `cost_usd` is `null`, its tokens are counted in
`cost_usd.unpriced_tokens`, and `build_daily_burn.py` prints a warning naming
the model and every affected day. `meta.json → cost.unpriced_models` lists
them. `cost_usd.total` is therefore a **lower bound** whenever
`unpriced_tokens` is nonzero. Silent zeros are how a cost dashboard starts
lying.

## Mixed fidelity — what "missing" means

Not every day can carry the same detail, and absence is never rendered as
zero. Three distinct states:

| Row shape | Meaning |
| --- | --- |
| no `breakdown`, no `cost_usd` | The day had no measured usage at all (estimates only). Nothing to split, nothing to cost. |
| no `breakdown`, but `cost_usd` present with `unpriced_tokens` = the whole aggregate | Exact tokens were captured before the split existed and the source logs have since been pruned. The tokens are real and frozen; their composition and cost are unknowable. |
| `breakdown` and `cost_usd` present | Full fidelity. |

Claude Code logs currently reach back only to 2026-05-19 while the ledger
starts 2026-05-04, so days before that can never gain a breakdown.

### `unattributed` tokens

Within a breakdown, `unattributed` counts tokens that are **real but carry no
type or model attribution**. The invariant, asserted by the test suite, is:

```
sum(model["tokens"]) + unattributed == <that tool's aggregate column>
```

so the breakdown can never quietly under-report the headline beside it. Two
things land here:

* **The 2026-06-08 Codex import — 449,154 tokens.** Fourteen `token_count`
  events, all within a 17-second window, one per file, each the only such
  event in its file, report a nonzero `total_tokens` with every per-type
  field at zero. They are not sessions: the surrounding entries carry
  `turn_id: "external-import-turn-N"`, they were written by a bulk Codex
  Desktop 0.137.0-alpha.4 import (one 3,359-line file written in 0.25s), and
  they are exactly the 14 files in the tree with no model recorded. The
  importer carried over each prior session's grand total but not its
  composition. The tokens are real, so they stay in `codex_tokens`; their
  split and model are genuinely unknown, so they are unattributed and
  unpriced rather than smeared across types or dropped.
* **A frozen aggregate larger than its split**, if a day's headline was
  captured before the breakdown existed and the logs have since thinned.

## Ledger rules for the new columns

The append-only guarantee protects *measurements*, not *derivations*. Every
leaf of the breakdown is held at a per-column high-water mark exactly like
the aggregate columns, and any preserved value is logged. Specifically:

* previous row has no breakdown, extraction has one → write it (new
  information about an old day is additive, so it is allowed in)
* previous row has one, extraction has none (logs pruned) → keep the captured
  breakdown verbatim; never overwrite it with zeros
* both present → per-leaf max, and every held-back leaf prints a line naming
  the date, the path and both values
* extraction finds a model the captured row never saw → add it
* a model only the captured row saw → keep it

To accept a genuine downward correction, edit the value in
`data/daily-burn.json` by hand; the next run sees the lower captured value
and keeps it.

## Estimated sources (labeled "estimated" in the UI)

Estimates are conservative weekday patterns, not measurements. **They are
never priced** — putting a dollar figure on a guess would launder it into
something it is not. The interview answers and the math:

| Column | Interview answer | Pattern | Weekly total |
| --- | --- | --- | --- |
| `claude_chat_est` | "Most days" | 30,000 tokens Mon–Fri (~4 conversations × ~7.5k tokens) | 150k |
| `chatgpt_est` | "A few times a week" | 15,000 tokens Mon/Wed/Fri (~2 conversations × ~7.5k) | 45k |
| `gemini_est` | Antigravity IDE sometimes + gemini.google.com web chat | 50,000 tokens Tue/Thu (agentic IDE sessions burn more) + 8,000 tokens Mon/Fri (web chat) | 116k |

A "conversation" is assumed to cost ~7.5k tokens total because chat UIs
resend conversation context with each turn. Agentic IDE use (Antigravity) is
assumed to burn roughly what a light Codex day shows in the exact logs
(~50k–500k); 50k/day is the conservative low end.

Estimates apply across the whole dashboard range (May 4 onward), per the
interview. Days with neither exact usage nor an estimate pattern (weekends
with no coding) are omitted.

## Day definition

A "day" is midnight-to-midnight **America/Chicago**. UTC timestamps in the
raw logs are converted before bucketing.
