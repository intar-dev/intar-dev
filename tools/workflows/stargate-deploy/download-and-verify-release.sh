#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Download and verify release".
set -euo pipefail
version="${RELEASE_TAG#stargate/v}"
archive="stargate_${version}_linux_amd64.tar.gz"
checksums="stargate_${version}_checksums.txt"
mkdir -p "${RUNNER_TEMP}/stargate-release/extracted"
gh release download "${RELEASE_TAG}" \
  --repo "${GITHUB_REPOSITORY}" \
  --pattern "${archive}" \
  --pattern "${checksums}" \
  --dir "${RUNNER_TEMP}/stargate-release"

grep -E "^[0-9a-f]{64}  ${archive}$" \
  "${RUNNER_TEMP}/stargate-release/${checksums}" \
  >"${RUNNER_TEMP}/stargate-release/expected"
test "$(wc -l <"${RUNNER_TEMP}/stargate-release/expected")" -eq 1
(
  cd "${RUNNER_TEMP}/stargate-release"
  sha256sum --check --strict expected
)
test "$(tar -tzf "${RUNNER_TEMP}/stargate-release/${archive}")" = $'./\n./stargate'
tar -xzf "${RUNNER_TEMP}/stargate-release/${archive}" \
  -C "${RUNNER_TEMP}/stargate-release/extracted" \
  --no-same-owner --no-same-permissions
test -f "${RUNNER_TEMP}/stargate-release/extracted/stargate"
test ! -L "${RUNNER_TEMP}/stargate-release/extracted/stargate"

archive_sha256="$(sha256sum "${RUNNER_TEMP}/stargate-release/${archive}" | awk '{print $1}')"
binary_sha256="$(sha256sum "${RUNNER_TEMP}/stargate-release/extracted/stargate" | awk '{print $1}')"
{
  printf 'archive=%s\n' "${RUNNER_TEMP}/stargate-release/${archive}"
  printf 'archive_sha256=%s\n' "${archive_sha256}"
  printf 'binary_sha256=%s\n' "${binary_sha256}"
} >>"${GITHUB_OUTPUT}"
