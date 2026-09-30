#!/usr/bin/env bash
# Website workflow, deploy job, step "Verify exact-main deployment revision".
set -euo pipefail
test "${GITHUB_REPOSITORY}" = intar-dev/intar-dev
test "${GITHUB_REF}" = refs/heads/main
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
# Deployment is deliberate in this file: a push to main, or a manual
# dispatch from main.
case "${GITHUB_EVENT_NAME}" in
  push|workflow_dispatch) ;;
  *)
    echo "unsupported deploy event: ${GITHUB_EVENT_NAME}" >&2
    exit 1
    ;;
esac
