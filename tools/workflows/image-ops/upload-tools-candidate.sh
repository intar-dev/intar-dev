#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Upload candidate objects" step.
cd apps/web
set -euo pipefail
disk="$(jq -r .tools_disk_sha256 "${TOOLS_DIR}/candidate.json")"
kino="$(jq -r .kino_sha256 "${TOOLS_DIR}/candidate.json")"
bunx wrangler r2 object put "${BUCKET}/guest-tools/scenario/disks/${disk}.ext4.zst" \
  --remote --jurisdiction eu --file "${TOOLS_DIR}/${disk}.ext4.zst"
bunx wrangler r2 object put "${BUCKET}/guest-tools/scenario/kino/${kino}/kino" \
  --remote --jurisdiction eu --file "${TOOLS_DIR}/kino"
bunx wrangler r2 object put "${BUCKET}/guest-tools/scenario/candidate.json" \
  --remote --jurisdiction eu --file "${TOOLS_DIR}/candidate.json" --content-type application/json
