# Collect usage from multiple machines

The optional Firestore ledger sits behind the existing static dashboard. Each
machine extracts measured usage locally and uploads scrubbed records. One
publisher pulls the ledger, applies the rate card, validates the public JSON, and
publishes a public Firestore snapshot. GitHub Pages serves the interface, which
loads that snapshot independently of deployments. With no `data/private/remote-config.json`, the hourly refresh
continues to use local logs exactly as before.

## Current deployment

The initial ledger is in Firebase project `ai-usage-ledger-lentz`, the `(default)`
Firestore Native mode database in US multi-region `nam5`. Namespace: `ai_usage`.
The publisher is `mac-m1-pro`; other collectors include `windows-dell-xps`
and `primary-mac`. Private configuration and credentials stay
on each machine. The project
[console](https://console.firebase.google.com/project/ai-usage-ledger-lentz/firestore)
shows the private ledger to authorized users.

## Setup

Use a dedicated Firebase project with a Firestore Native mode database. Record
its project ID and database ID (`(default)` unless you choose a named database).
Keep browser access to the measurement ledger denied. Only the validated
`public_reports/ai_usage` snapshot and its chunks permit anonymous `get` reads;
listing and all browser writes are denied. Collectors use the server SDK and IAM.
Firebase CLI login alone does **not** authenticate the Python SDK. Configure
Application Default Credentials, or point `GOOGLE_APPLICATION_CREDENTIALS` at a
service account credential stored outside this repository. For unattended cron,
provide that environment variable explicitly in the scheduler or its wrapper.
Use a dedicated service account with `roles/datastore.user` for trusted collectors;
that role grants database access, not just access to one machine's documents.
This first version assumes personally controlled machines. For untrusted clients,
put an authenticated ingestion service in front of the database instead.

Official references: [server SDK authentication](https://firebase.google.com/docs/firestore/client/libraries),
[server SDKs use IAM instead of Security Rules](https://firebase.google.com/docs/firestore/security/get-started),
and [Firestore IAM](https://cloud.google.com/firestore/native/docs/security/iam).
Do not deploy a blanket deny rule into an existing project serving another app.
A dedicated project makes isolation straightforward.

On each machine, install the optional dependency with Python 3.10 or newer:

```sh
python3 -m venv .venv-remote
.venv-remote/bin/python -m pip install -r requirements-remote.txt
```

The existing local pipeline still supports macOS cron's Python 3.9. Only the
Firestore SDK uses this separate environment. The dependency range is in
`requirements-remote.txt`; the implementation was tested with SDK 2.34.0.

Create `data/private/remote-config.json` (gitignored):

```json
{
  "project_id": "YOUR_FIREBASE_PROJECT_ID",
  "database": "(default)",
  "namespace": "ai_usage",
  "machine_id": "primary-mac"
}
```

Use the same project, database and namespace on every machine, but a distinct,
non-sensitive machine ID. Machine IDs are published in the report's collection
status. Titles already published by this project remain part of the cloud and
public thread data. Transcripts, raw session/request IDs, and local paths are not
uploaded. Credentials and all migration/retry files stay outside tracked data.

## Migrate the publisher once

Pause its hourly refresh while initializing, and do not run the standalone local
extract/build commands concurrently. The migration runs extraction and a normal
validated build to pair the current measurements with the frozen public history:

```sh
.venv-remote/bin/python scripts/remote_usage.py initialize
.venv-remote/bin/python scripts/remote_usage.py collect
.venv-remote/bin/python scripts/remote_usage.py pull
python3 scripts/build_daily_burn.py --remote
```

Initialization preserves historical daily totals, model splits and thread data.
Historical raw records remain outside the cloud ledger; only migration-day and
later identities enter it, so conflicting older copies cannot block collection.
An immutable private `remote-migration.json` draft allows an interrupted upload
to resume with the same baseline. The remote readiness document is created last;
collectors cannot upload into an unfinished migration. Use a fresh namespace if
you intentionally start a different ledger. A conflicting initialization fails
rather than replacing history. Retain the migration draft as a private backup.

Today's available records must match today's frozen aggregate before migration.
If logs have already been pruned for the current day, initialization fails with
an explanation; initialize on a day with complete current-day measurements.
Historical days may be incomplete because their existing totals remain frozen.

**Historical backfill is deliberately conservative.** Existing baseline record
identities are already included in the frozen report. Their future Codex growth
adds only the increment above the pinned baseline. Unseen records whose first
measurement precedes the migration instant are excluded: they might already be
in frozen history whose original identities were pruned. Known earlier-day
records stay frozen. There is no automatic override to guess at overlap.
Importing another machine's older history requires an audited migration with
sufficient original identities. A previously unseen Codex session already active
before migration can consequently lose its migration-day contribution; the next
day's snapshot is eligible. The collector reports exclusions among submitted migration-day records; older
days are outside the upload window.

After verification, resume `scripts/refresh_and_push.sh`. When private remote
configuration is present it checks publisher ownership, then performs collect
→ pull → remote build → validation → public Firestore publication. It never
commits or pushes usage updates. It uses `.venv-remote/bin/python` by default; set `REMOTE_PYTHON` to an
absolute interpreter path if the environment is elsewhere. A network or
validation failure stops publication and retains the previous public files.
Only the designated publisher should run this refresh script.

## Public dashboard and publisher ownership

The private `<namespace>/ledger` document's `publisher` field selects the active
publisher. If absent, the original `primary` is used. A handover updates only
`publisher`; `primary` remains the immutable migration provenance. This ledger's
publisher is `mac-m1-pro`. Its hourly cron runs `scripts/refresh_and_push.sh` and
logs to `/tmp/token-burn-refresh.log`. Other machines run `collect_usage.sh`.
Update an old publisher's checkout and scheduler when handing over; the new
publisher check prevents updated former publishers from publishing.

`remote_usage.py publish` validates the same four public dashboard files, then
writes immutable, checksum-addressed chunks under
`public_reports/ai_usage/versions/<sha256>/chunks/<index>`. Each chunk contains a
JSON string below Firestore's document size limit. The public manifest at
`public_reports/ai_usage` switches only after every chunk succeeds. Twenty-four
older generations are retained for in-flight readers. Failed uploads leave the
last good manifest intact.

The bundle contains daily rows, threads (including their already-public titles),
pricing, and collection metadata. It contains no raw measurement identities,
transcripts, paths, credentials, or migration data. `firestore.rules` grants only
anonymous `get` access to the public snapshot paths. The frontend uses the
[Firestore REST API](https://firebase.google.com/docs/firestore/use-rest-api)
without a credential. Deploy rules with:

```sh
firebase deploy --only firestore:rules --project ai-usage-ledger-lentz
```

`lib/dashboard-source.ts` loads a complete generation and verifies its SHA-256.
The page fetches on load, every five minutes while visible, and on returning to
the tab; unchanged versions need only the manifest read. An unavailable report
keeps the last loaded snapshot with a visible warning. Bundled JSON is the
initial/offline fallback, not live data. Theme and custom dates survive updates;
preset dates follow the updated ledger. Collector age still determines staleness.

GitHub builds deploy interface changes. Usage JSON changes alone no longer trigger
the Pages workflow. `data/pricing.json` remains the sole hand-maintained rate
card; rebuilding and publishing reprices the full public snapshot.

## Add another machine

Check out this version of the repository, install the optional dependency,
configure credentials, and create its private configuration with a different
machine ID. Then run:

```sh
bash scripts/collect_usage.sh
```

Schedule that script hourly on the other machine. It uploads only; it neither
builds nor pushes the report. The publisher discovers enrolled collectors on
its next pull. A collector's last successful scan is published, and the oldest
collector drives the freshness warning. Machines that have never successfully
uploaded are not enrolled or discoverable yet. An intentional retirement needs
removal of that machine's `collectors` document; usage records stay preserved.

The queue is saved before uploading. Failed uploads retain measurements for the
next run, even if source logs subsequently disappear. Successful retries count
once. An OS file lock prevents concurrent operations on a machine. The upload
queue is bound to its project, namespace, database, and machine ID, so a
configuration change cannot silently send pending data to another destination.

### Windows collectors

A Windows machine can collect (not publish). The extractor reads
`%USERPROFILE%\.claude\projects` and `%USERPROFILE%\.codex`, and the collector
lock uses `msvcrt` instead of `fcntl`. Windows ships no time zone database, so
install `tzdata` into the venv alongside the SDK:

```powershell
python -m venv .venv-remote
.venv-remote\Scripts\python.exe -m pip install -r requirements-remote.txt tzdata
```

Set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key stored outside the
repository (or use `gcloud auth application-default login`), create
`data/private/remote-config.json` with a distinct machine ID, then verify once:

```powershell
.venv-remote\Scripts\python.exe scripts\remote_usage.py collect
```

`scripts/collect_usage.sh` also works under Git Bash; it falls back to
`.venv-remote/Scripts/python.exe` when there is no `bin/python`. Schedule the
hourly run with Task Scheduler instead of cron, giving the task the credentials
variable explicitly:

```powershell
schtasks /Create /TN "ai-usage collect" /SC HOURLY /TR "cmd /c cd /d C:\code\ai-usage && set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json && .venv-remote\Scripts\python.exe scripts\remote_usage.py collect >> data\private\collect.log 2>&1"
```

Never run `initialize` or `refresh_and_push.sh` on a collector.

### A Mac restored with Migration Assistant

Migration Assistant can copy `data/private/remote-config.json`, the retry queue,
credentials, and the publisher's crontab. The integration uses the configured
`machine_id`, not the Mac's hostname or hardware identity, so the restored Mac
must get its own ID before collection. `mac-m1-pro` uses that exact ID.

Pause the copied usage job and ensure no collection is running. Preserve a
private backup of the configuration and queue, then set the new `machine_id`.
An empty copied `remote-pending.json` can be archived and removed; a nonempty
queue needs reconciliation before changing identity, because it belongs to the
original collector. Do not reinitialize the existing ledger or change the
historical migration draft to the new ID.

For an additional collector, replace its copied `refresh_and_push.sh` schedule
with an hourly `collect_usage.sh` job, leaving unrelated cron entries intact.
`mac-m1-pro` has since taken over publication and runs the publisher schedule
described above. Run collection
once and verify that Firestore has a separate `collectors/<machine_id>`
document. The publisher will include it on its next pull. Copied logs retain
their original record IDs so shared measurements are deduplicated across Macs.

## Accounting contract

Firestore documents live below `<namespace>/ledger`:

- `baseline_days/<date>`: immutable migrated daily history.
- `baseline_threads/<thread key>`: immutable migrated thread splits.
- `usage/<record ID>`: a canonical measurement, optional pinned baseline counts,
  and the machine IDs that have observed it.
- `collectors/<machine ID>`: successful collection time and source availability.

Claude record IDs are `cc-` plus SHA-256 of compact JSON `[message_id, request_id]`.
One record represents one request, so mirrored/forked transcripts cannot add it
twice. Zero-token synthetic calls without IDs use a hash of session, timestamp,
model and usage; measured calls without IDs fail upload explicitly.

Codex record IDs are `cx-` plus SHA-256 of compact JSON `[session_id, Chicago_day]`.
They use the existing high-water and recognized-counter-restart extraction.
A whole per-session/day snapshot replaces an older one only when every measured
leaf is nondecreasing. A fully smaller/pruned copy is ignored. Mixed changes
that redistribute captured tokens fail and require an audit; taking independent
leaf maxima could manufacture usage. Sessions sharing a parent still have
separate record IDs and fold into that parent's thread for display.

Prices never live in these records. The builder always uses
`data/pricing.json`, and unknown models or missing type splits remain unpriced.
Local chat estimates still apply once centrally; collectors never upload them.

## Cloud adapter input

A cloud service must expose actual token measurements before an adapter can
produce exact records. This change provides an import contract, not a vendor
usage API integration. A remote host running Claude Code or Codex can use the
normal collector directly. A service exporting compatible measurements can
supply a normalized private export:

```sh
.venv-remote/bin/python scripts/remote_usage.py collect --input /absolute/path/usage-export.json
```

The export has exactly three fields: `records` (an array), `collected_at` (an
ISO timestamp with timezone), and `sources_available` (the measured tools and
boolean availability, for example `{"codex": true}`). It uses that collection
time, not the import time, for freshness. Records have exactly `id`, `tool`
(`codex` or `claude_code`), `date` (Chicago day), `first_at` (first measurement
instant), `thread` (the existing opaque thread key), `title` (null or at most
120 characters), and `counts` (`models` and `unattributed`). Model entries use
nonnegative integer token fields whose sum equals `tokens`; Claude request
entries also have `calls: 1`. Use provider-native identities so an export and
local synchronized logs agree. `first_at` must describe the measurement, not
when it was downloaded. Inspect `validate_record()` for the complete contract.

Cloud sources without compatible measured usage remain estimated or unavailable;
this importer does not turn subscription limits or money into fictional tokens.
Use a separate machine ID for a cloud adapter so freshness is attributable.

## Verify

```sh
/usr/bin/python3 -m unittest discover -s tests -t .
npm run check
```

The default tests do not require credentials, SDK installation or a live database.
The optional real Firestore integration test uses a local emulator and a random
namespace under the demo project `demo-ai-usage`, never a production project:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8287 \
  .venv-remote/bin/python -m unittest tests.test_remote_emulator -v
```

Start the emulator with `firebase emulators:start --only firestore --project demo-ai-usage`
using the checked-in `firebase.json` first. The test exercises actual SDK
transactions, two collectors observing a shared session, migration baseline
increments, the remote report build, unknown pricing, and retention of a good
bundle when a corrupted record is encountered.
