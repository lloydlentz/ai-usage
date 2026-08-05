# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Token Burn Dashboard** — a local AI token-usage tracker that measures exact consumption from Claude Code and Codex through local logs, plus estimated usage from Claude chat, ChatGPT, and Gemini. The dashboard auto-deploys to GitHub Pages and updates hourly via cron.

### Key properties
- **Framework**: Next.js 16 with static export (`output: "export"`)
- **Deployment**: GitHub Pages at `/ai-usage` base path; triggered by changes to data files or source code
- **Data refresh**: Hourly cron job via `scripts/refresh_and_push.sh` (SSH-authenticated git push)
- **Data strategy**: Additive ledger—once exact data is captured, it's frozen even if source logs are pruned

## Commands

```bash
# Development
npm run dev          # `next dev` — defaults to http://localhost:3000
                     # .claude/launch.json runs the same script on port 3211 with
                     # autoPort, so a Claude Code preview may land on another free port

# Build and deploy
npm run build        # Build static export to out/ (triggered by GitHub Actions)
npm run lint         # Lint the TypeScript/React sources

# Data pipeline (manual—normally runs via cron)
python3 scripts/extract_exact.py    # Extract tokens from local logs into data/exact-daily.json
                                    # (+ data/private/day-detail.json, local only)
python3 scripts/build_daily_burn.py # Merge exact + estimates, price against data/pricing.json
                                    # → data/daily-burn.json + data/meta.json
bash scripts/refresh_and_push.sh    # Full pipeline: extract, build, commit, push
```

## Architecture

### Frontend (Next.js App Router)

**File:** `app/page.tsx` — one `"use client"` component plus every sub-component, all in
this file. `app/layout.tsx` only sets metadata and the basePath-prefixed favicon.
`data/daily-burn.json` and `data/meta.json` are imported directly, so they're baked in at build time.

**Themes:** two switchable looks selected by `ThemeToggle`:
- `"printrun"` (default) — paper stock, condensed display face, ring gauges
- `"ticker"` — black trading-desk sheet, monospace, scrolling tape

The choice persists to `localStorage` under `dashboard-theme`, and is applied both as
`data-theme` on `<main className="page">` and mirrored onto `<html>` via
`document.documentElement.dataset.theme` so the body background outside `.page` matches.

**Sections, in render order:**
1. `ThemeToggle`, then `TickerTape` (ticker theme only)
2. **Hero row** (`.heroRow`): `TickerHeroContent` / `PrintRunHero` beside the **Tool use** panel (`TickerToolUse` / `PrintRunToolUse`)
3. **Ledger** (`.ledger`): the `ShapeShift` chart, which carries both figures itself — the measured token volume in a rail at the flow's left end, the counterfactual cost as a label over its right end. See "The ledger" below
4. **Usage timeline** (`.timelineRow`, titled "Burn history" in the ticker theme): stacked-area chart of Claude Code + Codex CLI per day; the tooltip carries that day's cost
5. **Activity calendar** (`.calendarRow`, "Trading calendar" in the ticker theme): three heatmaps (Total, Claude Code, Codex CLI) + legend
6. **Stats**: total burn, peak day, 7d average, active days
7. **Where the money went** (cost by model) + **Which agent spent it** (cost by tool)
8. **Exact beside estimated** (source split) + **What is burning tokens** (drivers)
9. **How much of it was writing** (fermi equivalents) + **Peak day**
10. **Last 30 days** moving-average table, then the footer note

### The ledger

The headline used to be a single token count, which was 96% cache reads and so
tracked session length more than work done. The ledger shows both numbers at
equal weight and makes the gap between them explain itself.

Neither figure gets a headline block of its own. The token count sits in
`.shiftVolume`, a rail in `.shiftBody`'s first grid column, level with the left
end of the flow it measures; the cost sits in `.shiftHeads` over the right end.
Each is printed once — not once as a headline and again as a chart axis label.
Anything that belongs beside a figure (the `exact` pill, `BasisPill`, the "at
least" qualifier, the basis sentence) goes with it, via the `volumeNote` /
`costNote` props. Below 700px the rail stacks above the flow and `.shiftFlow`
takes an explicit height, since at phone width the viewBox ratio alone collapses
the chart to a sliver.

Only the cost side of the flow labels itself in-chart. The legend rail sits
against the volume bar and already names every band, so a left-hand `<text>`
would print the same words twice — which is why `SANKEY.lx` can sit at 26 rather
than reserving a label column.

- The token figure counts **measured** tokens only (exact logs), not the
  all-sources total: only measured tokens are ever priced, so pairing dollars
  with a figure that folds in unpriced chat estimates would put two different
  universes side by side.
- `ShapeShift` is the signature element: the same five token types weighted by
  volume and by cost, as two bars joined by ribbons that widen or collapse. It
  renders the thesis directly — 1-hour cache writes are 2.9% of the volume and
  31.7% of the cost; cache reads are 96.1% and 56.0%. Hovering or focusing a
  legend row isolates one type across both bars.
- Sub-pixel segments are floored to a visible sliver by `displayWidths()` and
  the others scaled down to keep the row at 100%. Only the geometry is nudged;
  the printed percentages stay exact.

**Every dollar figure carries the basis inline.** This usage ran on flat-rate
subscriptions, not metered API billing, so the dollar figure is a
counterfactual (`cost_usd.basis` is `api_list_price_counterfactual`, and
`meta.json → cost.disclaimer` spells it out). `BasisPill` renders an "at API
list" pill using the same mechanism as the existing exact/estimated fidelity
pills — a pill stays attached to the figure when someone crops a screenshot,
where a per-panel footnote would not. Do not introduce a dollar figure without
one. Table columns carry the qualifier in the column header
(`.thBasis`) so each cell inherits it.

**Key components:**
- `ShapeShift`: the two-bar-plus-ribbons cost/volume chart, with `displayWidths()` for its geometry. Its legend (`.shiftLegend`) is a vertical rail immediately left of the flow, ordered like the stack; hovering, focusing, or clicking a key isolates that type across both bars and reveals its token count and dollars on a line kept in the layout at `opacity: 0`
- `BasisPill` / `CostAmount` / `CellCost` / `UnpricedNote`: the four renderings of `CostKnowledge` — large figure, table cell, and the lower-bound disclosure
- `UsageTimeline`: SVG stacked-area chart (Claude Code under Codex CLI) with a hover crosshair, per-series dots, and a tooltip positioned in real pixels so its fixed width can't overflow a narrow container
- `GitHubHeatmap`: GitHub-style calendar grid (days-of-week rows, weeks columns)
- Ticker-only: `TickerTape`, `TickerHeroContent`, `TickerToolUse`, `CandleSpark`
- Print Run-only: `PrintRunHero`, `PrintRunToolUse`, `RingGauge`, `Sparkline`
- Shared: `ThemeToggle`, `Metric`, `Panel`, and the `buildDriverRows()` helper

**Styling:** `app/globals.css`
- Everything themes through CSS custom properties. `:root` holds the ticker palette (bg #000000, panel #0a0a0a, monospace `--font-body`); `[data-theme="printrun"]` overrides it (bg #eeeae2, ink #1a1a1a, sans body + condensed `--font-display`, thicker `--border-w`, visible `--cell-border`)
- Tool colors: `--accent` = Claude Code (#ff8c42 ticker / #f0653b print run), `--good` = Codex CLI (#8957e5 / #7a4fc2). The CSS variable names are historical
- Token-type ramp: `--t-input`, `--t-cache-write-5m`, `--t-cache-write-1h`, `--t-cache-read`, `--t-output`. Deliberately *not* the tool colors, which already mean "Claude" and "Codex". The ramp encodes the thesis — the huge, cheap type (`cache_read`) is the quietest color on the page and the tiny, expensive ones (`cache_write_1h`, `output`) are the loudest
- `--basis` colors the "at API list" pill; `--seam` is the hairline between adjacent bar segments (page background on ticker, ink on print run)
- Layout: `.heroRow` is a 12-column grid (`.heroCol` spans 8, the Tool use panel spans 4); `.timelineRow` and `.calendarRow` are full width; `.heatmapContainer` is a 3-column grid
- Heat classes: neutral `heat0`–`heat5`, plus `heatclaude0`–`heatclaude5` and `heatchatgpt0`–`heatchatgpt5`
- Responsive breakpoints at 880px, 800px, 560px, and 480px, plus a `min-width: 640px` tweak for the Print Run lead. The ticker tape's scroll animation is disabled under `prefers-reduced-motion`

### Data Layer (`lib/`)

**burn-data.ts**: Type definitions and normalization
- `BurnRow`: Normalized daily row — `date`, `codex_tokens`, `claude_code_tokens`, `claude_code_calls`, `claude_chat_est`, `chatgpt_est`, `gemini_est`, `total`, `driver`, `evidence`, plus `breakdown` and `cost` (below)
- `sourceColumns`: Display labels + fidelity (exact/estimated). The keys are historical; the labels name the *tool*, not the vendor — `codex_tokens` is **Codex CLI** (exact) and `chatgpt_est` is **ChatGPT app** (estimated). Both are OpenAI; labelling them both "ChatGPT" made the exact column look like it counted chat usage
- `tokenTypes` / `tokenTypeLabels`: the five priced types in lifecycle order — `input`, `cache_write_5m`, `cache_write_1h`, `cache_read`, `output`
- `normalizeRows()`: Coerce raw data to strict types, sort by date. Scalars go through `asNumber`; the nested `breakdown` / `cost_usd` objects are parsed explicitly so an absent field stays absent instead of flattening to 0
- `sumSource()`, `sumCost()`, `sumTokensByType()`, `sumByModel()`: roll-ups across a date range. `sumCost()` returns a `CostKnowledge`, not a number, so an unpriced day cannot disappear into a confident total

**The three cost states (`CostKnowledge`).** Absence never means zero. Every dollar figure in the UI is rendered from this union, and each variant has its own treatment:

| row shape | `CostKnowledge` | renders as |
|---|---|---|
| no `breakdown`, no `cost_usd` | `not-measured` | `—` "nothing measured to cost" |
| `cost_usd` present, total 0, all tokens unpriced | `unknown` | "not priced" + the unpriced token count |
| `cost_usd` present, `unpriced_tokens > 0` | `lower-bound` | `at least $X` / `≥ $X` |
| `cost_usd` present, `unpriced_tokens == 0` | `priced` | `$X` |

Gotchas the types are built to prevent: a Codex model entry has **no** `cache_write_5m` / `cache_write_1h` keys (OpenAI bills no cache-write premium), so per-type reads default to 0 rather than indexing; a model's `cost_usd` may be `null` (no rate card) and must render as unknown, never free; and `breakdown.<tool>.unattributed` is real tokens with no split — 2026-06-08 carries 449,154 of them and must not read as a free day.

**date-windows.ts**: Time range selection
- `WindowKey`: 90, 180, 365, or all. `app/page.tsx` pins it to `"180"` with no setter
- `getWindowRows()`: Filter rows to a time window; `toUtcDate()` parses a date string at UTC midnight

**token-math.ts**: Calculations
- `formatTokens()`: B above 1B, M above 1M, K above 1K, otherwise the raw number (e.g., "2.48B", "263.3M")
- `formatUsd()` / `formatPct()`: hand-rolled, not `Intl` — the page is prerendered in CI and hydrated in the browser, and the two do not have to share ICU data
- `logHeatLevel()`: Map token value to heatmap color intensity (0–5)
- `movingAverage7()`, `sumTokens()`: Aggregations for stats
- `fermiScale(outputTokens, inputTokens)`: words / reading time / novel equivalents, derived from **output** tokens only. It used to run on the grand total, which is 96% cache reads — the same context handed back to the model repeatedly — which turned one long session into "20,428 novels". Output tokens are the only ones that correspond to text that came into existence

### Data Pipeline (Python 3)

**extract_exact.py**: Parses local logs into daily buckets
- **Claude Code** source: `~/.claude/projects/**/*.jsonl` (Claude Code session logs)
  - Sums `input + cache_creation_input + cache_read_input + output` tokens per request
  - Deduplicates by message/request ID
  - Bucketed to America/Chicago timezone day
- **Codex** source: `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl` (Codex CLI session rollouts)
  - `token_count` events carry a cumulative running total per session; the script attributes the *delta* between consecutive events to the day of each event, so a multi-day session spreads across the days work actually happened
  - Attribution is a **high-water mark**, not a raw delta: only a total that exceeds the session's previous maximum contributes, and a lower total is treated as an out-of-order or duplicated line rather than a context reset. Each token field carries its own mark. (An earlier version treated a drop as a counter reset and double-counted; see the docstring in `extract_exact.py` for the session evidence.)
  - Per-project attribution keys off the session's `session_meta` `payload.cwd`, slash-to-dash normalized so it matches Claude Code's project-directory keys
  - Bucketed to America/Chicago day
- Outputs:
  - `data/exact-daily.json` — one row per day (`date`, `codex_tokens`, `claude_code_tokens`, `claude_code_calls`)
  - `data/private/day-detail.json` — per-project breakdown used to hand-label drivers. Gitignored; never ship or deploy it

**build_daily_burn.py**: Merge exact + estimates into final dataset
- Reads `data/exact-daily.json` and existing `data/daily-burn.json`
- Walks every day from `RANGE_START` (2026-05-04) to the latest date in either source, skipping days with no exact data, no estimate, and no previous row
- **Freezing strategy**: Rows with existing exact data stay frozen; lost logs won't erase history
- **Estimates** (see `ESTIMATES.md`):
  - Claude chat: 30k Mon–Fri
  - ChatGPT: 15k Mon/Wed/Fri
  - Gemini: 50k Tue/Thu + 8k Mon/Fri
- **Driver labels**: hand-maintained `DRIVERS` dict keyed by date. A day with exact usage but no entry falls back to `"unlabeled"`; a day with only estimates gets the `CHAT_ONLY` label
- Output: `data/daily-burn.json` (full merged dataset) + `data/meta.json` (refreshed_at timestamp)

**refresh_and_push.sh**: Cron entry point
- Runs extract → build → commit → push via SSH
- Stages only `data/daily-burn.json` and `data/meta.json`; skips the push if nothing changed
- Installed in `crontab -e` as: `0 * * * * /Users/lentz/code/ai-usage-claude/scripts/refresh_and_push.sh`
- Uses SSH key authentication (not stored credentials)

### Deployment

**GitHub Actions** (`.github/workflows/deploy.yml`)
- Triggered by pushes to main that touch `data/daily-burn.json`, `data/meta.json`, `data/pricing.json`, `app/**`, `lib/**`, `public/**`, `next.config.ts`, or `package.json` — plus manual `workflow_dispatch`
- Costs are precomputed into `daily-burn.json`, so a rate change normally arrives with a data refresh; `data/pricing.json` is listed so a pricing-only correction still rebuilds
- Builds with Node 22 → `npm ci` → `npm run build` → out/
- Deploys out/ to GitHub Pages

**GitHub Pages**
- Base path: `/ai-usage` (set in next.config.ts)
- Dev mode (NODE_ENV=development) disables basePath for local testing

## Data Flow & Key Patterns

### Time Bucketing
- Dates are ISO strings (YYYY-MM-DD) that the Python pipeline has already bucketed to America/Chicago day boundaries. In the UI they are *labels*, not instants
- Never parse a bare `"YYYY-MM-DD"` into a `Date` and read it back with the local-time getters: the site is statically prerendered in UTC CI and hydrated in the viewer's zone, so a local-clock read gives two different answers and shifts days. Parse on a fixed clock instead — `toUtcDate()` in `lib/date-windows.ts` is the shared helper — and pass an explicit `timeZone` to every `toLocaleDateString` / `toLocaleString` call

### Additive Ledger (Freezing)
Problem: Source logs get pruned (Claude Code deletes logs after 2 months). Solution: Once exact data is captured and `has_exact_data(row) == true`, that row's tokens are frozen. Even if logs disappear, the dashboard preserves history.

Implementation: In `build_daily_burn.py`, a row is frozen when the existing `daily-burn.json` row passes `has_exact_data()` **and** the day has no row at all in `exact-daily.json`. Frozen rows keep their exact counts; estimates and driver labels still refresh on every run.

### Activity Calendar Heatmap
- GitHub-style layout: rows = days of week (Mon–Sun), columns = weeks
- Color intensity mapped from token value using a log scale (`logHeatLevel(value, maxDay)`, where `maxDay` is the largest daily *total* in the window)
- Three calendars displayed horizontally: Total, Claude Code, Codex CLI
- The Total calendar tints each day by that day's dominant tool (`heatclaude*` / `heatchatgpt*`); the per-tool calendars use their own tool color; neutral `heat0`–`heat5` is the fallback

### Tool-use percentages
- Each tool's fill = today's tokens for that tool / that tool's peak daily tokens within the selected window
- Linear scale from 0 to 1 (not log scale)
- Print Run renders this as a `RingGauge` with a `Sparkline` of the window's history beneath; Ticker renders it as a quoted percentage with a `CandleSpark` of the last 14 days and a vs-yesterday delta

## Common Workflows

### Add a new data source or estimate
1. Edit `ESTIMATES.md` to document the new assumption
2. Update `sourceColumns` in `lib/burn-data.ts` (add new column + label)
3. Update `build_daily_burn.py`: add extraction or estimate logic
3b. If the source is metered, add its models to `data/pricing.json`. A model with no entry there is priced as **unknown**, never zero: its tokens land in `cost_usd.unpriced_tokens`, its per-model `cost_usd` is `null`, and the build prints a warning naming the model and the affected days
4. If the source should surface beyond the source-split panel and the table, wire it into `app/page.tsx` — the tool-use components (`TickerToolUse` / `PrintRunToolUse`), `UsageTimeline`, and the heatmap list are all built from an explicit list of columns

### Change time zone for bucketing
- Currently: America/Chicago (see `scripts/extract_exact.py` and `scripts/build_daily_burn.py`)
- Edit the `ZoneInfo()` calls in both Python scripts

### Adjust color scheme
- Update the CSS custom properties in `app/globals.css`: `:root { --accent, --good, ... }` is the ticker theme, `[data-theme="printrun"] { ... }` overrides it for print run
- Both themes must be edited together or one of them drifts
- Adjust responsive breakpoints there too

### Test data changes locally
- Run `python3 scripts/extract_exact.py` to pull local logs
- Run `python3 scripts/build_daily_burn.py` to merge
- `npm run dev` will reload the dashboard with fresh data

## Dev Notes

- **basePath logic**: In production, basePath is `/ai-usage`; in development (NODE_ENV), it's empty for local testing. `app/layout.tsx` repeats the same expression for the favicon path, because metadata icon paths aren't auto-prefixed — keep the two in sync
- **Pre-commit hooks**: None configured
- **Committed data**: `data/private/` and `data/exact-daily.json` are gitignored. `data/daily-burn.json`, `data/meta.json`, and `data/pricing.json` are committed and deployed. `pricing.json` is the hand-maintained rate card — no pipeline logic hard-codes a price; edit it and re-run `build_daily_burn.py` and the whole ledger reprices (cost is derived, never frozen)
- **Permissions** (`.claude/settings.local.json`, itself gitignored): Allows `npm run *`, reads under `~/.claude` and `~/.gemini`, and the preview-server tool
- **GitHub Auth**: Uses SSH key-based authentication (ed25519, added to GitHub account)
- **Static export**: Next.js builds to `out/` directory (no server runtime)
