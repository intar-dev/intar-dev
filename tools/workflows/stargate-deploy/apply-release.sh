#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Apply release".
set -euo pipefail
output="${RUNNER_TEMP}/stargate-apply-output"
ssh -F "${RUNNER_TEMP}/intar-ssh/config" \
  intar-stargate-production apply \
    "${RELEASE_TAG}" "${ARCHIVE_SHA256}" "${BINARY_SHA256}" \
  <"${ARCHIVE}" | tee "${output}"
backup_id="$(awk -F= '$1 == "backup_id" {print $2}' "${output}")"
[[ "${backup_id}" =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]]
test "$(grep -c '^backup_id=' "${output}")" -eq 1
printf 'backup_id=%s\n' "${backup_id}" >>"${GITHUB_OUTPUT}"
