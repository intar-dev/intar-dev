#!/usr/bin/env bash
# Website workflow, deploy job, step "Verify the deployed image registry cleanup worker".
set -euo pipefail
tools/deploy/registry-cleanup-child-gate.sh "${REGISTRY_CLEANUP_OPERATION}" \
  "${REGISTRY_CLEANUP_MODE}" "${GITHUB_SHA:0:12}" \
  "${RUNNER_TEMP}/registry-cleanup-child.json" | tee -a "${GITHUB_OUTPUT}"
