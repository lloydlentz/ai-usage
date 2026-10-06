#!/usr/bin/env bash
# Other machines upload privately; only the publisher builds and pushes reports.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
DEFAULT_RUNTIME="$REPO/.venv-remote/bin/python"
# A Windows venv (run under Git Bash) puts its interpreter in Scripts/.
[ -x "$DEFAULT_RUNTIME" ] || DEFAULT_RUNTIME="$REPO/.venv-remote/Scripts/python.exe"
REMOTE_RUNTIME="${REMOTE_PYTHON:-$DEFAULT_RUNTIME}"
"$REMOTE_RUNTIME" scripts/remote_usage.py collect
