#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Roll back release".
set -euo pipefail
ssh -F "${RUNNER_TEMP}/intar-ssh/config" \
  intar-stargate-production rollback "${ROLLBACK_BACKUP}"
