#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Restore prior release after failed public verification".
set -euo pipefail
[[ "${BACKUP_ID}" =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]]
ssh -F "${RUNNER_TEMP}/intar-ssh/config" \
  intar-stargate-production rollback "${BACKUP_ID}"
