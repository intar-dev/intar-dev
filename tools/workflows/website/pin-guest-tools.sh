#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Resolve and inject the verified guest-tools pin".
set -euo pipefail
release_dir="${RUNNER_TEMP}/guest-tools-release"
mkdir -p "${release_dir}"
# A release keeps the promoted stable pin. A tools rollout promotes the
# new pin first (image-ops tools-build, then tools-promote), so this
# release reads it here. The published objects are verified against
# the pin below.
bunx wrangler r2 object get \
  "${BUCKET}/guest-tools/scenario/stable.json" \
  --remote --jurisdiction eu --file "${release_dir}/manifest.json"
manifest="${release_dir}/manifest.json"
# The pin is generated from the published release objects, never from
# a declared digest, and the verifier needs these two readers to
# decompress the disk and read the embedded files.
for tool in zstd debugfs; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "missing required release verification tool: ${tool}" >&2
    exit 1
  }
done
disk="$(jq -er .tools_disk_sha256 "${manifest}")"
kino="$(jq -er .kino_sha256 "${manifest}")"
(
  cd apps/web
  bunx wrangler r2 object get \
    "${BUCKET}/guest-tools/scenario/disks/${disk}.ext4.zst" \
    --remote --jurisdiction eu --file "${release_dir}/tools.ext4.zst"
  bunx wrangler r2 object get \
    "${BUCKET}/guest-tools/scenario/kino/${kino}/kino" \
    --remote --jurisdiction eu --file "${release_dir}/kino"
)
pin_file="${RUNNER_TEMP}/release-static-pin.json"
evidence_file="${RUNNER_TEMP}/release-static-pin-evidence.json"
pin_check="${RUNNER_TEMP}/release-static-pin-check.json"
bun tools/deploy/guest-tools-pin.ts release \
  --manifest "${manifest}" \
  --disk "${release_dir}/tools.ext4.zst" \
  --kino "${release_dir}/kino" \
  --out "${pin_file}" > "${evidence_file}"
jq -e '.status == "verified"' "${evidence_file}" >/dev/null
bun tools/deploy/guest-tools-pin.ts check --pin "${pin_file}" > "${pin_check}"
jq -e '.status == "valid"' "${pin_check}" >/dev/null
# The ABI 2 release has no dynamic channel fallback, so the verified pin
# goes into the deployed configuration. The Worker reads this variable
# as a JSON string and then parses it, so store the serialized form. The
# assertion checks the type and that parsing it returns the verified
# pin; an object is not accepted.
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
printf 'Resolved the runtime pin from the stable channel.\n' >> "${GITHUB_STEP_SUMMARY}"
jq -c '{static_pin_sha256, compressed_disk_sha256, tools_disk_sha256, kino_sha256}' \
  "${evidence_file}" >> "${GITHUB_STEP_SUMMARY}"
printf 'deployment pin sha256: %s\n' \
  "$(jq -er '.static_pin_sha256' "${pin_check}")"
