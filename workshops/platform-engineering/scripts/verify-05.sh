#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/05-debug-with-ai/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-05-debugging-verified pass\n'
else
  printf 'INTAR_PROBE module-05-debugging-verified fail\n'
fi
exit "${status}"
