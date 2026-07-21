#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/06-serverless/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-06-knative-scale-to-zero pass\n'
else
  printf 'INTAR_PROBE module-06-knative-scale-to-zero fail\n'
fi
exit "${status}"
