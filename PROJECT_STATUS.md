# Token Burn Dashboard — Status

Last updated: 2026-10-06 by Codex

## Objective

Combine measured Claude Code and Codex usage from multiple trusted machines
without double-counting synchronized logs, then publish one static dashboard.
Current scope: restore dashboard publication of measured usage, including the
Migration Assistant-restored Mac `mac-m1-pro`.

## Current State

- Firestore integration is live in namespace `ai_usage`; `primary-mac` is the
  designated publisher. Verified collectors: `primary-mac`, `windows-dell-xps`,
  and `mac-m1-pro`.
- This Mac's gitignored `data/private/remote-config.json` now uses
  `machine_id: mac-m1-pro`. Its first upload succeeded and its retry queue is empty.
- This Mac's copied hourly publisher cron was replaced by hourly upload-only
  `scripts/collect_usage.sh`, logged to `/tmp/token-burn-collect.log`.
  Unrelated cron entries were preserved.
- Publication fix and refreshed data are ready to commit with the continuity
  documentation. Local configuration/scheduler changes and private backups
  remain gitignored.

## Next Steps

1. On the original publisher, run its normal `scripts/refresh_and_push.sh` or
   confirm the next scheduled refresh includes all three collectors.
2. After the next hourly collection on this Mac, check
   `/tmp/token-burn-collect.log` for a successful unattended upload.
3. When enrolling another restored machine, follow the Migration Assistant
   section in `REMOTE_USAGE.md` before running collection.

## Open Questions / Blockers

- This session verified a manual upload. The next unattended cron run and
  the original publisher's next publication have not yet been verified.

## Decisions

- 2026-10-06 — Use `mac-m1-pro` as this Mac's integration device ID and keep
  `primary-mac` as the sole publisher. Avoid two migrated machines publishing.
- Retain provider session/request record identities across devices, so copied
  logs are deduplicated rather than counted as new usage.

## Discoveries & Constraints

- Device identity is the configured `machine_id`; it is not generated from
  hardware or hostname. Migration Assistant copied `primary-mac` configuration,
  an empty queue, and the publisher cron to this machine.
- Changing the ID alone leaves a copied queue bound to the original ID. The
  empty queue was privately backed up and removed before first collection.
- Private backups: `data/private/remote-config.before-mac-m1-pro.json`,
  `data/private/remote-pending.before-mac-m1-pro.json`, and
  `data/private/crontab.before-mac-m1-pro.txt`. Keep these gitignored.
- The copied migration draft still belongs to the original publisher; do not
  rewrite it or reinitialize the live ledger on this Mac.

## Recently Completed

- 2026-10-06 — Found publication blocked by a shipped-data test indexing an
  absent zero-usage tool breakdown. Fixed the check, added a single-tool fixture,
  merged upstream Windows/UTF-8 support, and rebuilt the remote ledger. Today
  contains 31,756,182 measured Codex tokens. `npm run check` passed (209 Python
  tests, 12 frontend tests, lint, production build). Browser checks: 19 passed,
  one skipped. Deployment verification is in progress.

- 2026-10-06 — Enrolled `mac-m1-pro`, changed its scheduler, and documented
  restored-Mac setup. Verified live Firestore registration under the distinct
  ID, unchanged ledger primary, and empty retry queue. All 12 tests in
  `python3 -m unittest tests.test_remote_usage -v` passed. No commit or push.

## Key Files

- `REMOTE_USAGE.md` — setup, migration boundaries, accounting, and cloud imports.
- `scripts/remote_usage.py` — collection, immutable migration, and ledger pull.
- `scripts/collect_usage.sh` — collector-only scheduler entry point.
- `scripts/refresh_and_push.sh` — publisher entry point.
- `tests/test_remote_usage.py` — deduplication, retry, and accounting coverage.
