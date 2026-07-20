#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/08-portal/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-08-cloudbox-console-ready pass\n'
else
  printf 'INTAR_PROBE module-08-cloudbox-console-ready fail\n'
fi
exit "${status}"
