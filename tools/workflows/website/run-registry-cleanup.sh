#!/usr/bin/env bash
# Website workflow, deploy job, step "Run the image registry cleanup to completion".
set -euo pipefail
# The control plane serves again at this point, so the gate answers
# the run action as well as the release above it.
tools/deploy/registry-cleanup-gate.sh run delete \
  "${RUNNER_TEMP}/registry-cleanup-run.json"
