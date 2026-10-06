# Token Burn Dashboard — Status

Last updated: 2026-10-06 by Codex

## Objective

Combine measured usage from trusted machines without double-counting copied logs.
GitHub Pages serves the interface; Firestore serves independently refreshed data.

## Current State

- `mac-m1-pro` is the designated publisher in the private ledger's `publisher`
  field. The original `primary: primary-mac` remains migration provenance.
- Collectors: `mac-m1-pro`, `primary-mac`, `windows-dell-xps`. This Mac's unique
  ID is in gitignored `data/private/remote-config.json`.
- This Mac's hourly cron now runs `scripts/refresh_and_push.sh`, logging to
  `/tmp/token-burn-refresh.log`. In remote mode the script validates and publishes
  to Firestore, without a Git commit or push. Unrelated cron entries are intact.
- Public Firestore snapshot and rules are deployed. Anonymous public reads work;
  private-ledger reads and browser writes were verified denied (403).
- Implementation deployed from `0902487`; live browser verification passed.
  Handoff documentation through `e5ae1f1` is pushed. The page loads complete
  snapshots on mount and every five minutes while visible, verifies SHA-256, and keeps the
  last loaded snapshot with a warning on failure. Theme/custom dates survive.
- Usage-only JSON changes no longer trigger GitHub Pages deployment. Bundled
  files remain an initial/offline fallback; pricing is still maintained only in
  `data/pricing.json` and copied into each derived snapshot.
- Full publisher script succeeded: public snapshot advanced to the 14:11 build
  without a Git commit/push or another Pages deployment. The deployed UI loaded
  that newer snapshot and showed 40.4M Codex tokens for 2026-10-06 at verification.
- Uncommitted generated outputs: `data/daily-burn.json`, `data/meta.json`,
  `data/threads.json`, from the verified refresh. Remote refresh intentionally
  leaves these local build outputs unstaged; GitHub retains its bundled fallback.
- User authorized committing and pushing the handoff updates in
  `PROJECT_STATUS.md` and `AGENTS.md`. Generated JSON changes alone do not block
  hourly refresh; the documentation source changes are saved in this commit.

## Next Steps

1. Check `/tmp/token-burn-refresh.log` after the next scheduled publisher run
   (the full entry point has already succeeded manually). The current log ends
   with the inherited 13:00 validation failure, before this session's fix. The
   successful 14:11 manual run is in `data/private/public-refresh-verification.log`.
2. On the former publisher, update its checkout and replace its publisher job
   with `scripts/collect_usage.sh` if it remains active. It cannot be controlled
   from this Mac; updated code enforces the new publisher ownership.
3. If expanding cost coverage, verify public rates before editing
   `data/pricing.json`, then rebuild/publish. Current unpriced models include
   `claude-opus-5-5`, `gpt-6-luna`, `gpt-6-sol`, and `gpt-6.1-sol`.

## Open Questions / Blockers

- No implementation blocker. The former publisher's scheduler is not accessible
  from this session; its continued collection determines its freshness status.

## Decisions

- 2026-10-06 — User selected `mac-m1-pro` as primary publisher and requested
  separate Firestore data/GitHub UX. Preserve the migration baseline unchanged.
- Expose only validated public dashboard snapshots, retaining the private ledger.
  Upload immutable chunks before switching the manifest; retain 24 older versions.
- Retain provider record IDs across devices so migrated/synchronized logs count once.

## Discoveries & Constraints

- Migration Assistant copied identity, credentials, queue, and publisher cron.
  Identity is configured, not derived from hardware. Reassign before collecting.
- Empty copied queue and config were privately backed up; a nonempty queue needs
  reconciliation rather than reassignment. Keep all backups in `data/private/`.
- Failed public uploads preserve the last good manifest. Browser fetches load one
  immutable generation; prices, totals, thread splits, and status move together.
- Collector age remains the oldest successful scan, independent of publication.
- `primary-mac` still reported a 14:00 collection; do not assume it is retired.
  Retiring a collector requires an intentional heartbeat-document removal, not
  deletion of usage history. See `REMOTE_USAGE.md`.
- Leave generated JSON changes unstaged during routine remote publication.
  The refresh guard accepts those changes but skips when tracked source changes
  or staged changes are present; finish or save source work before cron resumes.

## Recently Completed

- 2026-10-06 — Public publisher/frontend split: `npm run check` passed (210
  Python tests, 13 frontend tests, lint, production build). Browser tests: 21
  passed, one skipped, including live polling and failure retention. Live rules
  checks confirmed public read/private read denial/write denial. GitHub Pages
  deployment succeeded; a real browser loaded manifest/chunk responses (200),
  showed the newer Firestore snapshot, and reported no page errors or fallback
  warning. Publisher refresh advanced data independently of deployment.
- 2026-10-06 — Restored blocked publication by fixing zero-usage missing-tool
  validation; deployed today’s 31.8M Codex tokens. Verified the 14:00 collector
  cron upload. The first new public Firestore snapshot includes later usage.

## Key Files

- `REMOTE_USAGE.md` — setup, handover, public snapshot, privacy, and accounting.
- `scripts/remote_usage.py` — ledger collection/pull, ownership, public publication.
- `scripts/refresh_and_push.sh` — hourly publisher (remote mode avoids Git pushes).
- `lib/dashboard-source.ts` / `app/use-dashboard-data.ts` — atomic browser loading.
- `firestore.rules` — public snapshot get-only access; private-ledger denial.
- `.github/workflows/deploy.yml` — interface deployment triggers.
