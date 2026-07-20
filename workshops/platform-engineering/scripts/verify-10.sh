#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/10-day2-ops/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-10-day-two-recovery-stable pass\n'
else
  printf 'INTAR_PROBE module-10-day-two-recovery-stable fail\n'
fi
exit "${status}"
