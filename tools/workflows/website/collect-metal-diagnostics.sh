#!/usr/bin/env bash
# Website workflow, deploy job, step "Collect personal-metal diagnostics".
set -euo pipefail
destination="${RUNNER_TEMP}/personal-metal/diagnostics"
mkdir -p "${destination}"
for item in production-d1-plan.json d1-removal-rehearsal.json \
  production-d1-info.json production-d1-bookmark.json registry-cleanup-mode.json \
  "intar-web-deploy-${GITHUB_RUN_ID}-metal-closed" \
  "intar-web-deploy-${GITHUB_RUN_ID}-metal-registration" \
  "intar-registry-cleanup-gate-${GITHUB_RUN_ID}"; do
  if [ -e "${RUNNER_TEMP}/${item}" ]; then
    cp -R "${RUNNER_TEMP}/${item}" "${destination}/"
  fi
done
