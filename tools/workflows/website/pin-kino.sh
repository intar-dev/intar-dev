#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Inject the Kino pin".
# tools/deploy/kino-pin.json becomes the Worker's KINO_PINS_JSON. Without the
# file the Worker has no Kino pin and places no VM; the site still deploys.
# The Worker counts a pin only when it names a stored Kino artifact.
set -euo pipefail
pin_file=tools/deploy/kino-pin.json
if [ ! -f "${pin_file}" ]; then
  printf 'No Kino pin: no VM is placed until one is deployed.\n' >> "${GITHUB_STEP_SUMMARY}"
  exit 0
fi
pins="$(bun tools/deploy/kino-artifact.ts check --file "${pin_file}")"
jq --arg pins "${pins}" '.vars.KINO_PINS_JSON = $pins' \
  "${DEPLOYMENT_CONFIG}" > "${DEPLOYMENT_CONFIG}.pinned"
mv "${DEPLOYMENT_CONFIG}.pinned" "${DEPLOYMENT_CONFIG}"
jq -e --arg pins "${pins}" '.vars.KINO_PINS_JSON == $pins' "${DEPLOYMENT_CONFIG}" >/dev/null
printf 'Kino pin: %s\n' "${pins}" >> "${GITHUB_STEP_SUMMARY}"
