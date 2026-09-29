#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Read host deployment plan".
set -euo pipefail
ssh -F "${RUNNER_TEMP}/intar-ssh/config" \
  intar-stargate-production plan
