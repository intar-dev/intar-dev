#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Read final host state".
set -euo pipefail
ssh -F "${RUNNER_TEMP}/intar-ssh/config" \
  intar-stargate-production plan
