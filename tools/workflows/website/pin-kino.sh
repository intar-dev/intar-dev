#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Inject the Kino pin".
# tools/deploy/kino-pin.json becomes the Worker's KINO_PINS_JSON. Without the
# file the Worker has no Kino pin and places no VM; the site still deploys.
# The Worker counts a pin only when every digest it names is a stored Kino
# artifact, and places no VM otherwise, so the deploy stops here, before
# maintenance, on a pin whose artifact image-ops has not pushed.
set -euo pipefail
pin_file=tools/deploy/kino-pin.json
if [ ! -f "${pin_file}" ]; then
  printf 'No Kino pin: no VM is placed until one is deployed.\n' >> "${GITHUB_STEP_SUMMARY}"
  exit 0
fi
pins="$(bun tools/deploy/kino-artifact.ts check --file "${pin_file}")"

# Read-only: the query names only literal digests the pin check validated.
d1_query() {
  jq -cn --arg sql "$1" '{sql: $sql, params: []}' > "${RUNNER_TEMP}/kino-pin-query.json"
  curl --fail-with-body --silent --show-error \
    --request POST \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data-binary "@${RUNNER_TEMP}/kino-pin-query.json" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query" \
    | jq -ce 'select(.success == true and .result[0].success == true) | .result[0].results'
}
table="$(d1_query "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_manifests'")"
if [ "$(jq length <<<"${table}")" -eq 0 ]; then
  echo "${pin_file} pins Kino, but D1 has no registry yet. Deploy the registry migrations without a pin, run image-ops with the kino-promote option, then pin." >&2
  exit 1
fi
digests="$(jq -r '[.[] | .current, .previous | select(. != null)] | unique | map("\u0027" + . + "\u0027") | join(",")' <<<"${pins}")"
stored="$(d1_query "SELECT digest FROM registry_manifests WHERE artifact_type = 'application/vnd.intar.kino.v1' AND digest IN (${digests})")"
missing="$(jq -nr --argjson pins "${pins}" --argjson stored "${stored}" \
  '([$pins[] | .current, .previous | select(. != null)] | unique) - [$stored[].digest] | join(" ")')"
if [ -n "${missing}" ]; then
  echo "The registry stores no Kino artifact ${missing}. Run image-ops with the kino-promote option for that release before this deploy." >&2
  exit 1
fi
jq --arg pins "${pins}" '.vars.KINO_PINS_JSON = $pins' \
  "${DEPLOYMENT_CONFIG}" > "${DEPLOYMENT_CONFIG}.pinned"
mv "${DEPLOYMENT_CONFIG}.pinned" "${DEPLOYMENT_CONFIG}"
jq -e --arg pins "${pins}" '.vars.KINO_PINS_JSON == $pins' "${DEPLOYMENT_CONFIG}" >/dev/null
printf 'Kino pin: %s\n' "${pins}" >> "${GITHUB_STEP_SUMMARY}"
