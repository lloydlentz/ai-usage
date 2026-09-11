#!/usr/bin/env bash
# Hourly refresh; rejects inconsistent data before committing or publishing.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"

# A scheduled refresh must never publish somebody's in-progress source changes
# or consume an unrelated staged commit.
if [[ "$(git branch --show-current)" != "main" ]] || ! git diff --cached --quiet; then
  echo "refresh skipped: main branch and an empty staging area are required"
  exit 0
fi
while IFS= read -r path; do
  case "$path" in
    data/daily-burn.json|data/meta.json) ;;
    *) echo "refresh skipped: source changes are in progress"; exit 0 ;;
  esac
done < <(git diff --name-only)

LOCK="$(git rev-parse --git-dir)/token-burn-refresh.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "refresh skipped: another refresh holds $LOCK"
  exit 0
fi
cp data/daily-burn.json "$LOCK/daily-burn.json"
cp data/meta.json "$LOCK/meta.json"
validated=0
cleanup() {
  code=$?
  if [[ "$validated" == 0 ]]; then
    cp "$LOCK/daily-burn.json" data/daily-burn.json
    cp "$LOCK/meta.json" data/meta.json
  fi
  if [[ "$code" != 0 ]]; then
    echo "refresh failed at $(date -u): last validated data retained; see this log for the error" >&2
  fi
  rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Missing source directories are a collector failure, not a zero-usage day.
[[ -d "$HOME/.claude/projects" ]]
[[ -d "$HOME/.codex/sessions" || -d "$HOME/.codex/archived_sessions" ]]
python3 scripts/extract_exact.py
python3 scripts/build_daily_burn.py
# Cron has a minimal PATH; the Python-only pipeline must not depend on npm.
python3 -m unittest discover -s tests -t . -v
validated=1
git add data/daily-burn.json data/meta.json
if git diff --cached --quiet; then
  echo "no changes"
else
  git commit -m "data: validated refresh $(date +%Y-%m-%d)" -- data/daily-burn.json data/meta.json
fi
git push
