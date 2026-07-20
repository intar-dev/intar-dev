#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/02-gitops/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  printf 'INTAR_PROBE module-02-gitops-reconciled pass\n'
else
  printf 'INTAR_PROBE module-02-gitops-reconciled fail\n'
fi
exit "${status}"
