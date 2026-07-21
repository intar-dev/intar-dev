#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/09-capstone/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-09-picture-pipeline-complete pass\n'
else
  printf 'INTAR_PROBE module-09-picture-pipeline-complete fail\n'
fi
exit "${status}"
