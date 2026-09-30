#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Drain and recheck maintenance".
set -euo pipefail
sleep 30
expected_version_id="$(jq -er '.deployed_version_id' \
  "${RUNNER_TEMP}/web-maintenance.json")"
deployment="${RUNNER_TEMP}/maintenance-after-drain-deployment.json"
bunx wrangler deployments status --name intar-dev --json \
  > "${deployment}"
jq -e --arg expected_version_id "${expected_version_id}" '
  .versions | length == 1 and
  .[0].version_id == $expected_version_id and
  .[0].percentage == 100
' "${deployment}" >/dev/null
root_status="$(curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}' https://intar.dev/)"
probe="${RUNNER_TEMP}/maintenance-after-drain.json"
probe_status="$(curl --silent --show-error \
  --header 'Accept: application/json' --output "${probe}" \
  --write-out '%{http_code}' \
  https://intar.dev/api/control-plane-maintenance-probe)"
test "${root_status}" = 503
test "${probe_status}" = 503
test "$(jq -er '.code' "${probe}")" = maintenance
