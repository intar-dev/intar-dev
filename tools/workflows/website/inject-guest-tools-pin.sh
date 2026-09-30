#!/usr/bin/env bash
# Website workflow, deploy job, step "Inject the verified ABI 2 guest-tools pin".
set -euo pipefail
case "${MAINTENANCE_MODE}" in
  auto|on|off) ;;
  *) echo "maintenance input must be auto, on, or off" >&2; exit 1 ;;
esac
if [ -z "${GUEST_TOOLS_PIN_JSON}" ]; then
  echo 'SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON is not set.' >&2
  echo 'The ABI 2 release has no dynamic channel fallback, so the' >&2
  echo 'verified release pin must come from the release bundle.' >&2
  exit 1
fi
pin_file="${RUNNER_TEMP}/release-static-pin.json"
pin_check="${RUNNER_TEMP}/release-static-pin-check.json"
printf '%s' "${GUEST_TOOLS_PIN_JSON}" > "${pin_file}"
bun tools/deploy/guest-tools-pin.ts check --pin "${pin_file}" > "${pin_check}"
jq -e '.status == "valid"' "${pin_check}" >/dev/null
# The Worker reads this variable as a JSON string and then parses it,
# so store the serialized form. The assertion checks the type and that
# parsing it returns the verified pin; an object is not accepted.
jq --slurpfile pin "${pin_file}" \
  '.vars.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON = ($pin[0] | tojson)' \
  "${DEPLOYMENT_CONFIG}" > "${DEPLOYMENT_CONFIG}.pinned"
mv "${DEPLOYMENT_CONFIG}.pinned" "${DEPLOYMENT_CONFIG}"
jq -e --slurpfile pin "${pin_file}" '
  (.vars.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON | type) == "string" and
  (
    .vars.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON | fromjson
  ) == $pin[0]
' "${DEPLOYMENT_CONFIG}" >/dev/null
printf 'deployment pin sha256: %s\n' \
  "$(jq -er '.static_pin_sha256' "${pin_check}")"
{
  printf 'MAINTENANCE_MODE=%s\n' "${MAINTENANCE_MODE}"
} >> "${GITHUB_ENV}"
