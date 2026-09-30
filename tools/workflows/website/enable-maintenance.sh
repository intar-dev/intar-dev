#!/usr/bin/env bash
# Website workflow, deploy job, step "Enable maintenance for pending migrations".
set -euo pipefail
# The maintenance version is the tested configuration with only the
# maintenance variable changed. It keeps the binding to the collector,
# and deploy-web.sh tags it web-<sha12>-maintenance, the tag the
# collector gate recognises when a failed deploy leaves it serving.
config_dir="$(cd "$(dirname "${DEPLOYMENT_CONFIG}")" && pwd)"
maintenance_config="${config_dir}/wrangler-maintenance.json"
test ! -e "${maintenance_config}"
jq '.vars.CONTROL_PLANE_MAINTENANCE = "on"' \
  "${DEPLOYMENT_CONFIG}" > "${maintenance_config}"
jq -e '.vars.CONTROL_PLANE_MAINTENANCE == "on"' \
  "${maintenance_config}" >/dev/null
WEB_DEPLOY_LABEL=maintenance tools/deploy/deploy-web.sh \
  "${maintenance_config}" \
  "${DATABASE_ID}" \
  "${ACTIVATION_SECRETS_FILE}" \
  "${RUNNER_TEMP}/web-maintenance.json"
