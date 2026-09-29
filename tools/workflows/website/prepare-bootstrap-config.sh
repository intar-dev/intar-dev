#!/usr/bin/env bash
# Website workflow, deploy job, step "Prepare the parent bootstrap configuration".
cd apps/web
set -euo pipefail
# The parent phase that runs before the collector exists omits the
# binding to it. Everything else is the tested configuration.
bootstrap="${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler-bootstrap.json"
test ! -e "${bootstrap}"
jq '(.services // []) |= map(select(.binding != "REGISTRY_CLEANUP"))' \
  "${DEPLOYMENT_CONFIG}" > "${bootstrap}"
jq -e '[.services[]? | select(.binding == "REGISTRY_CLEANUP")] | length == 0' \
  "${bootstrap}" >/dev/null
jq -e '.name == "intar-dev"' "${bootstrap}" >/dev/null
printf 'BOOTSTRAP_DEPLOYMENT_CONFIG=%s\n' "${bootstrap}" \
  >> "${GITHUB_ENV}"
