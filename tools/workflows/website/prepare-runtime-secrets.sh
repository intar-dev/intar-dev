#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Prepare runtime secrets".
set -euo pipefail
test "${#CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}" -ge 43
test -n "${STARGATE_EGRESS_IPV4_CIDRS}"
secrets_file="${RUNNER_TEMP}/website-runtime-secrets.json"
jq -n '{
  CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: env.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET,
  STARGATE_EGRESS_IPV4_CIDRS: env.STARGATE_EGRESS_IPV4_CIDRS
}' > "${secrets_file}"
chmod 600 "${secrets_file}"
printf 'ACTIVATION_SECRETS_FILE=%s\n' "${secrets_file}" \
  >> "${GITHUB_ENV}"
