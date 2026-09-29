#!/usr/bin/env bash
# image-ops workflow, tools-promote job, "Promote the exact candidate while drained" step.
set -euo pipefail
curl --fail --silent --show-error --max-time 30 \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  https://intar.dev/registry/v1/cutover/gate \
  | jq -e '.state == "drained" and .active_desired_vms == 0' >/dev/null
curl --fail --silent --show-error --max-time 60 --request POST \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  --header "x-intar-candidate-sha256: ${EXPECTED_CANDIDATE_SHA256}" \
  https://intar.dev/registry/v1/guest-tools/promote > "${TOOLS_DIR}/promotion.json"
disk="$(jq -r .tools_disk_sha256 "${TOOLS_DIR}/candidate.json")"
jq -e --arg disk "${disk}" '.ok == true and .stable.tools_disk_sha256 == $disk' \
  "${TOOLS_DIR}/promotion.json" >/dev/null
curl --fail --silent --show-error --max-time 30 \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  "https://intar.dev/registry/v1/builds/revisions/${REVISION}?tools=stable" > "${TOOLS_DIR}/stable.json"
jq -e --arg disk "${disk}" '.ok == true and .tools_channel == "stable" and .guest_tools.tools_disk_sha256 == $disk' \
  "${TOOLS_DIR}/stable.json" >/dev/null
# The promoted stable tuple must name the Kino of the exact release
# that was verified. The disk is already checked above.
jq -e --arg kino "$(jq -r .kino_sha256 "${TOOLS_DIR}/candidate.json")" \
  '.stable.kino_sha256 == $kino' "${TOOLS_DIR}/promotion.json" >/dev/null
