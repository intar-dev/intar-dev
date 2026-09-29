#!/usr/bin/env bash
# Website workflow, deploy job, step "Run the staged personal-metal action".
set -euo pipefail
# This release uses the existing collector and HOST_RUNTIME namespace.
# No bootstrap or normal workflow cleanup may run alongside it.
test "${COLLECTOR_PRESENT}" = true
config="$(dirname "${DEPLOYMENT_CONFIG}")/wrangler-metal.json"
mode=off
if [ "${METAL_ACTION}" = deploy ]; then mode=on; fi
jq --arg mode "${mode}" '.vars.CONTROL_PLANE_MAINTENANCE = $mode' \
  "${DEPLOYMENT_CONFIG}" > "${config}"
evidence="${RUNNER_TEMP}/personal-metal"
args=()
if [ "${METAL_ACTION}" != deploy ]; then
  checks="${evidence}/fleet-checks.json"
  printf '%s' "${METAL_CHECKS}" | jq . > "${checks}"
  if [ "${METAL_ACTION}" = open-admission ]; then
    # Copy actual supporting output; never set proof pass flags here.
    jq --arg path "${RUNNER_TEMP}/metal-proof/personal-metal-proof.evidence" \
      '.personalMetalProof.evidencePath = $path' "${checks}" > "${checks}.tmp"
    mv "${checks}.tmp" "${checks}"
  fi
  args+=("${checks}")
fi
bun tools/deploy/release-personal-metal.ts "${METAL_ACTION}" \
  "${config}" "${DATABASE_ID}" "${ACTIVATION_SECRETS_FILE}" "${evidence}" "${args[@]}"
printf 'Metal action %s completed for %s.\n' "${METAL_ACTION}" "${GITHUB_SHA}" >> "${GITHUB_STEP_SUMMARY}"
if [ "${METAL_ACTION}" != open-admission ]; then
  echo 'Personal registration and scenario admission remain closed. Real VM/NAT proof is still required.' >> "${GITHUB_STEP_SUMMARY}"
fi
