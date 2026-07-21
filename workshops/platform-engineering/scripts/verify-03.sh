#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/03-data/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-03-data-services-ready pass\n'
else
  printf 'INTAR_PROBE module-03-data-services-ready fail\n'
fi
exit "${status}"
