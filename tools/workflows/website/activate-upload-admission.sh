#!/usr/bin/env bash
# Website workflow, plan job, step "Activate the D1 upload admission switch for a delete release".
set -euo pipefail
tools/deploy/registry-cleanup-activation.sh enforce \
  "${RUNNER_TEMP}/registry-cleanup-activation.json"
jq -c '{ok, requested_mode, http_status, problem}' \
  "${RUNNER_TEMP}/registry-cleanup-activation.json" \
  >> "${GITHUB_STEP_SUMMARY}"
