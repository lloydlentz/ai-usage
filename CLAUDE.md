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
npm run dev          # Start dev server on port 3211 (from .claude/launch.json)

# Build and deploy
npm run build        # Build static export to out/ (triggered by GitHub Actions)
npm run lint         # Lint TypeScript and React

# Data pipeline (manual—normally runs via cron)
python3 scripts/extract_exact.py    # Extract tokens from local logs into data/exact-daily.json
python3 scripts/build_daily_burn.py # Merge exact + estimates → data/daily-burn.json + data/meta.json
bash scripts/refresh_and_push.sh    # Full pipeline: extract, build, commit, push
```

## Architecture

### Frontend (Next.js App Router)

**File:** `app/page.tsx`
- Single page component that loads `data/daily-burn.json` at build time
- Renders four main sections:
  1. **Hero & Stats**: total burn, peak day, 7d average, active days
  2. **Tool Use**: gauge dials for Claude and ChatGPT (today's % of peak daily) + weekly/total summaries + sparklines
  3. **Activity Calendar**: GitHub-style heatmaps showing token burn over time (3 calendars: Total, Claude, ChatGPT)
  4. **Exact beside estimated**: source split breakdown + drivers breakdown

**Key components:**
- `BurnGauges`: Renders two gauge dials (Claude orange, ChatGPT blue-purple) with sparklines
- `Sparkline`: Compact trend line showing usage history
- `GitHubHeatmap`: GitHub-style calendar grid (days-of-week rows, weeks columns)
- `Metric`, `Panel`, `Driver`: Utility components for stats and breakdowns

**Styling:** `app/globals.css`
- Dark theme (bg: #101012, panel: #18191c)
- CSS variables: `--accent` (Claude orange #FF8C42), `--good` (ChatGPT blue-purple #8957E5)
- Grid layout: gaugeAndCalendarRow uses 12-column grid (Tool Use: 4 cols, Activity Calendar: 8 cols)
- Responsive breakpoints at 1400px and 880px

### Data Layer (`lib/`)

**burn-data.ts**: Type definitions and normalization
- `BurnRow`: Normalized daily row with `date`, `claude_code_tokens`, `codex_tokens`, exact & estimated columns, `total`, `driver`, `evidence`
- `sourceColumns`: Display labels (Claude, ChatGPT, Claude chat, etc.) + fidelity (exact/estimated)
- `normalizeRows()`: Coerce raw data to strict types, sort by date
- `sumSource()`: Sum tokens by column across a date range

**date-windows.ts**: Time range selection
- `windows`: defines 90, 180, all-time ranges (unused in current UI after recent redesign)
- `getWindowRows()`: Filter selectedRows to a time window

**token-math.ts**: Calculations
- `formatTokens()`: Format with M/B/K suffixes (e.g., "263.3M")
- `logHeatLevel()`: Map token value to heatmap color intensity (0–5)
- `movingAverage7()`, `sumTokens()`, `weeklyTotals()`, `fermiScale()`: Aggregations for stats

### Data Pipeline (Python 3)

**extract_exact.py**: Parses local logs into daily buckets
- **Claude Code** source: `~/.claude/projects/**/*.jsonl` (Claude Code session logs)
  - Sums `input + cache_creation_input + cache_read_input + output` tokens per request
  - Deduplicates by message/request ID
  - Bucketed to America/Chicago timezone day
- **Codex** source: `~/.codex/sessions/**/*.jsonl` (GitHub Copilot session logs)
  - Extracts per-event token deltas (not session totals) to handle multi-day sessions correctly
  - Each delta attributed to its event timestamp
  - Bucketed to America/Chicago day
- Output: `data/exact-daily.json` (keyed by ISO date string)

**build_daily_burn.py**: Merge exact + estimates into final dataset
- Reads `data/exact-daily.json` and existing `data/daily-burn.json`
- **Freezing strategy**: Rows with existing exact data stay frozen; lost logs won't erase history
- **Estimates** (see `ESTIMATES.md`):
  - Claude chat: 30k Mon–Fri
  - ChatGPT: 15k Mon/Wed/Fri
  - Gemini: 50k Tue/Thu + 8k Mon/Fri
- Output: `data/daily-burn.json` (full merged dataset) + `data/meta.json` (refreshed_at timestamp)

**refresh_and_push.sh**: Cron entry point
- Runs extract → build → commit → push via SSH
- Skips push if no changes
- Intended for `crontab -e`: `0 6 * * * /Users/lentz/code/ai-usage-claude/scripts/refresh_and_push.sh`
- Uses SSH key authentication (not stored credentials)

### Deployment

**GitHub Actions** (`.github/workflows/deploy.yml`)
- Triggered by pushes to main that touch: data files, app/lib/public, next.config.ts, package.json
- Builds with Node 22 → `npm run build` → out/
- Deploys out/ to GitHub Pages

**GitHub Pages**
- Base path: `/ai-usage` (set in next.config.ts)
- Dev mode (NODE_ENV=development) disables basePath for local testing

## Data Flow & Key Patterns

### Time Bucketing
- Dates are ISO strings (YYYY-MM-DD) representing Chicago midnight boundaries
- When parsing UTC timestamps, add "T12:00:00" to avoid browser timezone shifts (e.g., "2026-07-16T12:00:00" instead of bare "2026-07-16")

### Additive Ledger (Freezing)
Problem: Source logs get pruned (Claude Code deletes logs after 2 months). Solution: Once exact data is captured and `has_exact_data(row) == true`, that row's tokens are frozen. Even if logs disappear, the dashboard preserves history.

Implementation: In `build_daily_burn.py`, check `has_exact_data(prev_row)` on existing rows. If true, preserve the old counts even if logs are gone.

### Activity Calendar Heatmap
- GitHub-style layout: rows = days of week (Mon–Sun), columns = weeks
- Color intensity (heat0–heat5) mapped from token value using log scale (`logHeatLevel()`)
- Three calendars displayed horizontally: Total, Claude, ChatGPT

### Gauge Percentages
- Today's gauge fill = today's tokens / max daily tokens (across all historical data)
- Linear scale from 0 to 1 (not log scale)
- Spark lines show historical trend beneath each gauge

## Common Workflows

### Add a new data source or estimate
1. Edit `ESTIMATES.md` to document the new assumption
2. Update `sourceColumns` in `lib/burn-data.ts` (add new column + label)
3. Update `build_daily_burn.py`: add extraction or estimate logic
4. Update gauge/calendar rendering in `app/page.tsx` if needed

### Change time zone for bucketing
- Currently: America/Chicago (see `scripts/extract_exact.py` and `scripts/build_daily_burn.py`)
- Edit the `ZoneInfo()` calls in both Python scripts

### Adjust color scheme
- Update CSS variables in `app/globals.css` (`:root { --accent, --good, ... }`)
- Adjust responsive breakpoints there too

### Test data changes locally
- Run `python3 scripts/extract_exact.py` to pull local logs
- Run `python3 scripts/build_daily_burn.py` to merge
- `npm run dev` will reload the dashboard with fresh data

## Dev Notes

- **basePath logic**: In production, basePath is `/ai-usage`; in development (NODE_ENV), it's empty for local testing
- **Pre-commit hooks**: None configured (rely on TypeScript build for type safety)
- **Permissions** (`.claude/settings.local.json`): Allows npm run, local log reads, and preview server
- **GitHub Auth**: Uses SSH key-based authentication (ed25519, added to GitHub account)
- **Static export**: Next.js builds to `out/` directory (no server runtime)
