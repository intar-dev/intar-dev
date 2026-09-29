#!/usr/bin/env bash
# release.yml, job release, step "Validate preserved resume payload".
set -euo pipefail
artifact_metadata="$(
  gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${PAYLOAD_ID}" \
    --jq '[.id, .name, (.expired | tostring), .digest, (.workflow_run.id | tostring)] | @tsv'
)"
IFS=$'\t' read -r \
  artifact_id artifact_name artifact_expired artifact_digest artifact_run_id \
  <<<"${artifact_metadata}"
if [ "${artifact_id}" != "${PAYLOAD_ID}" ] || \
  [ "${artifact_name}" != "${PAYLOAD_NAME}" ] || \
  [ "${artifact_expired}" != "false" ] || \
  [ "${artifact_digest}" != "${PAYLOAD_DIGEST}" ] || \
  [ "${artifact_run_id}" != "${PAYLOAD_RUN_ID}" ]; then
  echo "Stored release payload does not match immutable tag metadata." >&2
  exit 1
fi

run_metadata="$(
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${PAYLOAD_RUN_ID}" \
    --jq '[.id, .event, .head_sha, .path] | @tsv'
)"
IFS=$'\t' read -r run_id run_event run_source_sha run_path \
  <<<"${run_metadata}"
if [ "${run_id}" != "${PAYLOAD_RUN_ID}" ] || \
  [ "${run_event}" != "workflow_dispatch" ] || \
  [ "${run_source_sha}" != "${PAYLOAD_SOURCE_SHA}" ] || \
  [ "${run_path}" != ".github/workflows/release.yml" ]; then
  echo "Stored release payload did not come from the expected release run." >&2
  exit 1
fi
