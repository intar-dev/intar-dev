#!/usr/bin/env bash
# stargate-deploy workflow, job preflight, step "Validate operation".
set -euo pipefail
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
case "${OPERATION}" in
  plan|apply)
    [[ "${RELEASE_TAG}" =~ ^stargate/v[0-9]+\.[0-9]+\.[0-9]+$ ]]
    test -z "${ROLLBACK_BACKUP}"
    ;;
  rollback)
    [[ "${ROLLBACK_BACKUP}" =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]]
    ;;
  *) exit 2 ;;
esac
