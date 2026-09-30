#!/usr/bin/env bash
# Website workflow, deploy job, step "Verify exact-main deployment revision".
set -euo pipefail
test "${GITHUB_REPOSITORY}" = intar-dev/intar-dev
test "${GITHUB_REF}" = refs/heads/main
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
# A re-run keeps its run's commit, and a newer revision may have deployed since.
# Only a re-run for main's tip may deploy; otherwise dispatch from main.
if [ "${GITHUB_RUN_ATTEMPT}" != 1 ]; then
  main="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
  if [ "${main}" != "${GITHUB_SHA}" ]; then
    echo "main moved on to ${main}; dispatch Website from main instead of re-running." >&2
    exit 1
  fi
fi
# Deployment is deliberate in this file: a push to main, or a manual
# dispatch from main.
case "${GITHUB_EVENT_NAME}" in
  push|workflow_dispatch) ;;
  *)
    echo "unsupported deploy event: ${GITHUB_EVENT_NAME}" >&2
    exit 1
    ;;
esac
