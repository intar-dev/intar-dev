#!/usr/bin/env bash
# Website workflow, plan job, step "Resolve the verified guest-tools pin".
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
bun tools/deploy/guest-tools-pin.ts release \
  --manifest "${manifest}" \
  --disk "${release_dir}/tools.ext4.zst" \
  --kino "${release_dir}/kino" \
  --out "${pin_file}" > "${evidence_file}"
jq -e '.status == "verified"' "${evidence_file}" >/dev/null
bun tools/deploy/guest-tools-pin.ts check --pin "${pin_file}" >/dev/null
printf 'static_pin_json=%s\n' "$(jq -c . "${pin_file}")" >> "${GITHUB_OUTPUT}"
printf 'Resolved the runtime pin from the stable channel.\n' >> "${GITHUB_STEP_SUMMARY}"
jq -c '{static_pin_sha256, compressed_disk_sha256, tools_disk_sha256, kino_sha256}' \
  "${evidence_file}" >> "${GITHUB_STEP_SUMMARY}"
