#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Verify uploaded objects by re-download" step.
cd apps/web
set -euo pipefail
# Byte-level verification of the published objects. This lane
# builds and publishes only; it never calls the control plane, so it
# can run while the previous ABI is still serving. Promotion to the
# stable channel is a separate lane that needs the new plane.
verify_dir="${TOOLS_DIR}/verify"
mkdir -p "${verify_dir}"
disk="$(jq -r .tools_disk_sha256 "${TOOLS_DIR}/candidate.json")"
kino="$(jq -r .kino_sha256 "${TOOLS_DIR}/candidate.json")"
bunx wrangler r2 object get \
  "${BUCKET}/guest-tools/scenario/disks/${disk}.ext4.zst" \
  --remote --jurisdiction eu --file "${verify_dir}/${disk}.ext4.zst"
bunx wrangler r2 object get \
  "${BUCKET}/guest-tools/scenario/kino/${kino}/kino" \
  --remote --jurisdiction eu --file "${verify_dir}/kino"
bunx wrangler r2 object get \
  "${BUCKET}/guest-tools/scenario/candidate.json" \
  --remote --jurisdiction eu --file "${verify_dir}/candidate.json"
cmp --silent "${TOOLS_DIR}/candidate.json" "${verify_dir}/candidate.json"
cmp --silent "${TOOLS_DIR}/${disk}.ext4.zst" "${verify_dir}/${disk}.ext4.zst"
cmp --silent "${TOOLS_DIR}/kino" "${verify_dir}/kino"
test "$(sha256sum "${verify_dir}/${disk}.ext4.zst" | cut -d ' ' -f 1)" = \
  "$(jq -r .compressed_disk_sha256 "${TOOLS_DIR}/candidate.json")"
test "$(sha256sum "${verify_dir}/kino" | cut -d ' ' -f 1)" = "${kino}"
jq -n --arg disk "${disk}" --arg kino "${kino}" \
  '{uploaded_objects_verified: 3, tools_disk_sha256: $disk, kino_sha256: $kino}' \
  > "${TOOLS_DIR}/upload-verification.json"
cat "${TOOLS_DIR}/upload-verification.json"
