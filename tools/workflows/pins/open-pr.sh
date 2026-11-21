#!/usr/bin/env bash
# qemu.yml and kernel.yml, job pin, step "Open the pull request":
#   open-pr.sh <branch> <title> <body file> <path>...
# Commits the given paths as the release app, pushes them as the bot branch
# and opens its pull request, or updates the open one. Nothing is pushed when
# the paths hold no change.
set -euo pipefail
branch="$1" title="$2" body="$3"
shift 3
[[ "${branch}" =~ ^updates/[a-z0-9-]+$ ]]
if git diff --quiet -- "$@"; then
  echo "Nothing changed in $*."
  exit 0
fi
bot="${APP_SLUG}[bot]"
bot_id="$(gh api "users/${bot}" --jq .id)"
git config user.name "${bot}"
git config user.email "${bot_id}+${bot}@users.noreply.github.com"
gh auth setup-git --hostname github.com
git checkout -B "${branch}"
git add -- "$@"
git commit --quiet -m "${title}"
tools/workflows/release/push-bot-branch.sh "${branch}"
pr="$(gh pr list --head "${branch}" --base main --state open --json number --jq '.[0].number // empty')"
if [ -n "${pr}" ]; then
  gh pr edit "${pr}" --title "${title}" --body-file "${body}"
else
  gh pr create --base main --head "${branch}" --title "${title}" --body-file "${body}"
fi
