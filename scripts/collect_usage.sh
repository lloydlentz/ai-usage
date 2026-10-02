#!/usr/bin/env bash
# Other machines upload privately; only the publisher builds and pushes reports.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
REMOTE_RUNTIME="${REMOTE_PYTHON:-$REPO/.venv-remote/bin/python}"
"$REMOTE_RUNTIME" scripts/remote_usage.py collect
