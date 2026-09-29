#!/usr/bin/env bash
# Website workflow, deploy job, step "Verify the report-only collector through the parent binding".
set -euo pipefail
tools/deploy/registry-cleanup-gate.sh plan report-only \
  "${RUNNER_TEMP}/registry-cleanup-preview.json"
