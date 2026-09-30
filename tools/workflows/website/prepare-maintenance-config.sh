#!/usr/bin/env bash
# Website workflow, deploy job, step "Prepare maintenance configuration".
cd apps/web
set -euo pipefail
# Only the maintenance variable changes from the tested configuration.
config_dir="$(cd "$(dirname "${DEPLOYMENT_CONFIG}")" && pwd)"
maintenance_config="${config_dir}/wrangler-maintenance.json"
test ! -e "${maintenance_config}"
jq '.vars.CONTROL_PLANE_MAINTENANCE = "on"' \
  "${DEPLOYMENT_CONFIG}" > "${maintenance_config}"
jq -e '.vars.CONTROL_PLANE_MAINTENANCE == "on"' \
  "${maintenance_config}" >/dev/null
printf 'MAINTENANCE_DEPLOYMENT_CONFIG=%s\n' "${maintenance_config}" \
  >> "${GITHUB_ENV}"
