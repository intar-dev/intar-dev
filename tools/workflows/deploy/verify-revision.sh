#!/usr/bin/env bash
# deploy.yml, jobs deploy-web and deploy-docs, step "Verify exact-main deployment revision".
set -euo pipefail
test "${GITHUB_REPOSITORY}" = intar-dev/intar-dev
test "${GITHUB_REF}" = refs/heads/main
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
# A re-run keeps its run's commit, and a newer revision may have deployed since.
# Only a re-run for main's tip may deploy; otherwise dispatch Deploy from main.
if [ "${GITHUB_RUN_ATTEMPT}" != 1 ]; then
  main="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
  if [ "${main}" != "${GITHUB_SHA}" ]; then
    echo "main moved on to ${main}; dispatch Deploy from main instead of re-running." >&2
    exit 1
  fi
fi
# Deployment follows a CI run on main, or a dispatch from main.
case "${GITHUB_EVENT_NAME}" in
  workflow_run|workflow_dispatch) ;;
  *)
    echo "unsupported deploy event: ${GITHUB_EVENT_NAME}" >&2
    exit 1
    ;;
esac
