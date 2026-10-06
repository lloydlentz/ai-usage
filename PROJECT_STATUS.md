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
- Publication fix and refreshed data were committed and pushed as `5833675`.
  GitHub Pages deployment succeeded; the live page shows October 6 usage
  (31.8M Codex tokens at publication) and the `mac-m1-pro` collector.
- The 14:00 local cron collection succeeded, verified in
  `/tmp/token-burn-collect.log`. Local configuration and backups remain gitignored.

## Next Steps

1. Resolve publisher ownership: user was asked whether this Mac should take
   over hourly publication; no answer yet. It currently remains upload-only.
2. If keeping the original publisher, update its checkout with `git pull` so
   the corrected shipped-data check runs in `scripts/refresh_and_push.sh`.
   Its next unattended publication has not been verified.
3. When enrolling another restored machine, follow the Migration Assistant
   section in `REMOTE_USAGE.md` before running collection.

## Open Questions / Blockers

- Collection is verified both manually and through cron. Ongoing dashboard
  publication still needs a confirmed active publisher; the original publisher
  was failing validation before the fix and must update its checkout.

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
  one skipped. GitHub deployment succeeded and a live HTTP check confirmed
  October 6 and `mac-m1-pro`. The 14:00 cron upload also succeeded.

- 2026-10-06 — Enrolled `mac-m1-pro`, changed its scheduler, and documented
  restored-Mac setup. Verified live Firestore registration under the distinct
  ID, unchanged ledger primary, and empty retry queue. All 12 tests in
  `python3 -m unittest tests.test_remote_usage -v` passed. Documentation was
  subsequently included in the publication-fix commit.

## Key Files

- `REMOTE_USAGE.md` — setup, migration boundaries, accounting, and cloud imports.
- `scripts/remote_usage.py` — collection, immutable migration, and ledger pull.
- `scripts/collect_usage.sh` — collector-only scheduler entry point.
- `scripts/refresh_and_push.sh` — publisher entry point.
- `tests/test_remote_usage.py` — deduplication, retry, and accounting coverage.
