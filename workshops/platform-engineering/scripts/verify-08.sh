#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/08-portal/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app

  portal_workspace_app_curl() {
    curl -sS --max-time 15 \
      -H "Host: ${public_host}" \
      -H "X-Forwarded-Host: ${public_host}" \
      -H 'X-Forwarded-Proto: https' \
      -H 'X-Forwarded-Port: 443' \
      "$@"
  }

  if ! portal_status="$(portal_workspace_app_curl \
    --output /dev/null \
    --write-out '%{http_code}' \
    http://localhost:30600/)"; then
    printf 'Cloudbox Console did not answer through the canonical workspace-app Host\n' >&2
    status=1
  elif [[ "${portal_status}" != "200" ]]; then
    printf 'Cloudbox Console returned HTTP %s for canonical workspace-app Host %s\n' \
      "${portal_status}" "${public_host}" >&2
    status=1
  fi

  if (( status == 0 )); then
    invalid_public_host=wa-workshop-probe.intar.app.attacker.invalid
    if ! invalid_host_status="$(curl -sS --max-time 15 \
      --output /dev/null \
      --write-out '%{http_code}' \
      -H "Host: ${invalid_public_host}" \
      -H "X-Forwarded-Host: ${public_host}" \
      -H 'X-Forwarded-Proto: https' \
      -H 'X-Forwarded-Port: 443' \
      http://localhost:30600/)"; then
      printf 'Cloudbox Console invalid-Host probe did not complete\n' >&2
      status=1
    elif [[ "${invalid_host_status}" != "400" ]]; then
      printf 'Cloudbox Console accepted invalid Host %s with HTTP %s\n' \
        "${invalid_public_host}" "${invalid_host_status}" >&2
      status=1
    fi
  fi

  if (( status == 0 )); then
    if ! s3_put_status="$(portal_workspace_app_curl \
      --output /dev/null \
      --write-out '%{http_code}' \
      -X PUT \
      http://localhost:30600/__intar-s3/probe)"; then
      printf 'Cloudbox S3 unsafe-method probe did not complete\n' >&2
      status=1
    elif [[ "${s3_put_status}" != "405" ]]; then
      printf 'Cloudbox same-origin S3 adapter accepted PUT (HTTP %s)\n' \
        "${s3_put_status}" >&2
      status=1
    fi
  fi

  if (( status == 0 )); then
    if ! s3_head_status="$(portal_workspace_app_curl \
      --head \
      --output /dev/null \
      --write-out '%{http_code}' \
      http://localhost:30600/__intar-s3/app-assets/hello.txt)"; then
      printf 'Cloudbox S3 HEAD probe did not reach the workspace-app adapter\n' >&2
      status=1
    elif [[ "${s3_head_status}" != 2* &&
            "${s3_head_status}" != "403" ]]; then
      printf 'Cloudbox S3 HEAD path returned HTTP %s instead of RustFS 2xx/403\n' \
        "${s3_head_status}" >&2
      status=1
    fi
  fi

  if (( status == 0 )); then
    if ! grafana_launcher="$(portal_workspace_app_curl \
      --fail \
      http://localhost:30600/__intar-grafana)"; then
      printf 'Cloudbox Grafana launcher did not answer through the workspace-app adapter\n' >&2
      status=1
    elif [[ "${grafana_launcher}" != *"Workspace applications"* ||
            "${grafana_launcher}" != *"Grafana"* ||
            "${grafana_launcher}" == *"localhost"* ]]; then
      printf 'Cloudbox Grafana launcher did not provide safe Intar navigation\n' >&2
      status=1
    fi
  fi
fi
if (( status == 0 )); then
  printf 'INTAR_PROBE module-08-cloudbox-console-ready pass\n'
else
  printf 'INTAR_PROBE module-08-cloudbox-console-ready fail\n'
  last_failure="$(
    awk '/FAIL:/{ line=$0 } END{ print line }' <<<"${output}"
  )"
  if [[ -n "${last_failure}" ]]; then
    last_failure="${last_failure#*FAIL: }"
    printf 'INTAR_FAIL %.72s\n' "${last_failure}" >&2
  fi
fi
exit "${status}"
