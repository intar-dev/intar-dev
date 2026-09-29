#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Verify public routing".
set -euo pipefail
curl --fail-with-body --silent --show-error https://ws.intar.app/healthz >/dev/null
garbage_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://garbage.intar.app/)"
test "${garbage_status}" = 404
if [ "${OPERATION}" = apply ]; then
  application_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://wa-no-such-route.intar.app/)"
  test "${application_status}" = 401
fi
