#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/02-gitops/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app
  if ! gitea_page="$(curl -fsS --max-time 15 \
    -H "Host: ${public_host}" \
    -H "X-Forwarded-Host: ${public_host}" \
    -H 'X-Forwarded-Proto: https' \
    -H 'X-Forwarded-Port: 443' \
    "http://localhost:30300/cloudbox/platform")"; then
    printf 'Gitea did not answer through the declared workspace-app port\n' >&2
    status=1
  elif [[ "${gitea_page}" == *"gitea-http.gitea.svc.cluster.local"* ||
          "${gitea_page}" == *"localhost:30300"* ||
          "${gitea_page}" != *"${public_host}"* ]]; then
    printf 'Gitea did not derive its public URL from %s\n' "${public_host}" >&2
    status=1
  fi
fi
if (( status == 0 )); then
  printf 'INTAR_PROBE module-02-gitops-reconciled pass\n'
else
  printf 'INTAR_PROBE module-02-gitops-reconciled fail\n'
fi
exit "${status}"
