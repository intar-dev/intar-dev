#!/usr/bin/env bash
# Website workflow, deploy job, step "Prepare maintenance configuration".
cd apps/web
set -euo pipefail
config_dir="$(cd "$(dirname "${DEPLOYMENT_CONFIG}")" && pwd)"
maintenance_config="${config_dir}/wrangler-maintenance.json"
test ! -e "${maintenance_config}"
# The maintenance deploy is also the phase that runs before the
# collector exists, so it starts from the bootstrap configuration when
# this rollout is a first rollout.
jq '.vars.CONTROL_PLANE_MAINTENANCE = "on"' \
  "${BOOTSTRAP_DEPLOYMENT_CONFIG:-${DEPLOYMENT_CONFIG}}" > "${maintenance_config}"
jq -e '.vars.CONTROL_PLANE_MAINTENANCE == "on"' \
  "${maintenance_config}" >/dev/null
# The candidate deploy at the end of the lane runs after the collector
# exists, so it carries the binding to it. Only the maintenance
# variable changes from the tested configuration.
full_maintenance_config="${config_dir}/wrangler-maintenance-full.json"
test ! -e "${full_maintenance_config}"
jq '.vars.CONTROL_PLANE_MAINTENANCE = "on"' \
  "${DEPLOYMENT_CONFIG}" > "${full_maintenance_config}"
jq -e '.vars.CONTROL_PLANE_MAINTENANCE == "on"' \
  "${full_maintenance_config}" >/dev/null
printf 'MAINTENANCE_DEPLOYMENT_CONFIG=%s\n' "${maintenance_config}" \
  >> "${GITHUB_ENV}"
printf 'MAINTENANCE_FULL_DEPLOYMENT_CONFIG=%s\n' \
  "${full_maintenance_config}" >> "${GITHUB_ENV}"
if [ "${MAINTENANCE_MODE}" = on ]; then
  # The cutover holds the control plane closed for the whole window.
  # The candidate deploy must not reopen it: the runtime gates reopen
  # in order, and only then does a maintenance-off deploy run. The
  # candidate still carries the binding to the collector.
  printf 'DEPLOYMENT_CONFIG=%s\n' "${full_maintenance_config}" \
    >> "${GITHUB_ENV}"
fi
