#!/usr/bin/env bash
# Daily refresh: re-extract logs, rebuild data, commit, push.
# GitHub Actions then builds and deploys to Pages automatically.
#
# Add to crontab with: crontab -e
#   0 6 * * * /Users/lentz/code/ai-usage-claude/scripts/refresh_and_push.sh >> /tmp/token-burn-refresh.log 2>&1

set -euo pipefail
REPO=/Users/lentz/code/ai-usage-claude
cd "$REPO"

echo "=== $(date) ==="
python3 scripts/extract_exact.py
python3 scripts/build_daily_burn.py

# Only commit and push if data changed.
if git diff --quiet data/daily-burn.json; then
  echo "no changes to data/daily-burn.json, skipping push"
  exit 0
fi

git add data/daily-burn.json
git commit -m "data: daily refresh $(date +%Y-%m-%d)"
git push
echo "pushed — GitHub Actions will deploy"
