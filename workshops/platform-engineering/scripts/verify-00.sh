#!/usr/bin/env bash
set -uo pipefail
readonly expected_crane_version=0.21.7
verifier=/opt/platform-engineering-workshop/lab/00-setup/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  crane_version="$(crane version 2>&1 || true)"
  if [[ "${crane_version}" != *"${expected_crane_version}"* ]]; then
    printf 'expected preinstalled crane %s, got: %s\n' "${expected_crane_version}" "${crane_version}" >&2
    status=1
  fi
fi
if (( status == 0 )); then
  printf 'INTAR_PROBE module-00-workspace-ready pass\n'
else
  printf 'INTAR_PROBE module-00-workspace-ready fail\n'
  last_failure="$(
    awk '/FAIL:/{ line=$0 } END{ print line }' <<<"${output}"
  )"
  if [[ -n "${last_failure}" ]]; then
    last_failure="${last_failure#*FAIL: }"
    printf 'INTAR_FAIL %.72s\n' "${last_failure}" >&2
  fi
fi
exit "${status}"
