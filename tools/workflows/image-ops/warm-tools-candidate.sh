#!/usr/bin/env bash
# image-ops workflow, tools-promote job, "Warm every host and wait for the candidate cache" step.
set -euo pipefail
curl --fail --silent --show-error --max-time 60 --request POST \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  --header "x-intar-candidate-sha256: ${EXPECTED_CANDIDATE_SHA256}" \
  https://intar.dev/registry/v1/guest-tools/warm > "${TOOLS_DIR}/warm.json"
disk="$(jq -r .tools_disk_sha256 "${TOOLS_DIR}/candidate.json")"
jq -e --arg disk "${disk}" '.ok == true and .candidate.tools_disk_sha256 == $disk and (.warmed_host_ids | length > 0)' \
  "${TOOLS_DIR}/warm.json" >/dev/null
# The warm set is the expected fleet for this promotion. Readiness
# must cover that set: a host that drops out is a failed promotion,
# not a smaller success.
expected_hosts="$(jq -c '[.warmed_host_ids[]] | sort' "${TOOLS_DIR}/warm.json")"
for _ in $(seq 1 24); do
  curl --fail --silent --show-error --max-time 30 \
    --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
    "https://intar.dev/registry/v1/builds/revisions/${REVISION}?tools=candidate" > "${TOOLS_DIR}/cache.json"
  # A stale or failed build set is terminal: its artifacts are
  # retired, so waiting can never warm it. Name the builds and stop.
  if jq -e '
    (.builds // [])
    | map(select(.status == "stale" or .phase == "failed"))
    | length > 0
  ' "${TOOLS_DIR}/cache.json" >/dev/null 2>&1; then
    jq -c '[.builds[] | select(.status == "stale" or .phase == "failed")
      | {scenario_id, status, phase, artifacts_retired}]' \
      "${TOOLS_DIR}/cache.json" >&2
    echo 'The revision has stale or failed image builds.' >&2
    echo 'Rebuild and republish the revision before promoting it.' >&2
    exit 1
  fi
  if jq -e --arg disk "${disk}" --argjson expected "${expected_hosts}" '
    .ok == true and .guest_tools.tools_disk_sha256 == $disk and
    ([.hosts[].host_id] | sort) == $expected and
    all(.hosts[]; .ready == true and .desired_guest_tools_ready == true and .actual_guest_tools_ready == true)
  ' "${TOOLS_DIR}/cache.json" >/dev/null; then
    exit 0
  fi
  sleep 5
done
jq -c '{state, hosts: [.hosts[]? | {host_id, ready, desired_guest_tools_ready, actual_guest_tools_ready}]}' \
  "${TOOLS_DIR}/cache.json" >&2 || true
echo 'The candidate host cache did not become ready for every warmed host.' >&2
exit 1
