#!/usr/bin/env bash
# image-ops workflow, tools-promote job, "Require drained host and retain previous stable pin" step.
cd apps/web
set -euo pipefail
curl --fail --silent --show-error --max-time 30 \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  https://intar.dev/registry/v1/cutover/gate \
  | jq -e '.state == "drained" and .active_desired_vms == 0' >/dev/null
bunx wrangler r2 object get "${BUCKET}/guest-tools/scenario/stable.json" \
  --remote --jurisdiction eu --file "${TOOLS_DIR}/previous-stable.json"
