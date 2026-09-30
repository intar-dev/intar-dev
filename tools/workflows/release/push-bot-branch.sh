#!/usr/bin/env bash
# Called by update-release-pr.sh and web-pins.sh: force-push HEAD to the bot
# branch $1. GitHub refuses a GitHub App push that changes .github/workflows
# unless the app has the workflows permission, and moving the branch onto a
# main whose workflows changed counts as such a change. So that branch and its
# pull request are closed, and the branch is pushed anew.
set -euo pipefail
branch="$1"
if git fetch --quiet origin "refs/heads/${branch}" 2>/dev/null &&
  ! git diff --quiet FETCH_HEAD HEAD -- .github/workflows; then
  pr="$(gh pr list --head "${branch}" --base main --state open --json number --jq '.[0].number // empty')"
  if [ -n "${pr}" ]; then
    gh pr close "${pr}" --comment "Main changed workflow files, so this pull request continues in a new one."
  fi
  git push origin --delete "${branch}"
fi
git push --force origin "HEAD:refs/heads/${branch}"
