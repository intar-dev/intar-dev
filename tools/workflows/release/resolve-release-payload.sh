#!/usr/bin/env bash
# release.yml, job release, step "Resolve release payload".
set -euo pipefail
if [ "${RESUME}" = "true" ]; then
  payload_digest="${RESUME_DIGEST}"
  payload_id="${RESUME_ID}"
  payload_run_id="${RESUME_RUN_ID}"
  payload_source_sha="${RESUME_SOURCE_SHA}"
else
  case "${NEW_DIGEST}" in
    sha256:*) payload_digest="${NEW_DIGEST}" ;;
    *) payload_digest="sha256:${NEW_DIGEST}" ;;
  esac
  payload_id="${NEW_ID}"
  payload_run_id="${GITHUB_RUN_ID}"
  payload_source_sha="${GITHUB_SHA}"
fi
if ! [[ "${payload_id}" =~ ^[0-9]+$ ]] || \
  ! [[ "${payload_run_id}" =~ ^[0-9]+$ ]] || \
  ! [[ "${payload_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
  ! [[ "${payload_source_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release payload metadata is not canonical." >&2
  exit 1
fi
{
  echo "digest=${payload_digest}"
  echo "id=${payload_id}"
  echo "name=${PAYLOAD_NAME}"
  echo "run_id=${payload_run_id}"
  echo "source_sha=${payload_source_sha}"
} >> "${GITHUB_OUTPUT}"
