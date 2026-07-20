#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/07-ci/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-07-in-cluster-build-published pass\n'
else
  printf 'INTAR_PROBE module-07-in-cluster-build-published fail\n'
fi
exit "${status}"
