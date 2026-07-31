#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/06-serverless/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app
  upstream_host=hello.demo.127.0.0.1.sslip.io
  if ! knative_page="$(curl -fsS --max-time 60 \
    -H "Host: ${upstream_host}" \
    -H "X-Forwarded-Host: ${public_host}" \
    -H 'X-Forwarded-Proto: https' \
    -H 'X-Forwarded-Port: 443' \
    http://localhost:31080/)"; then
    printf 'Knative did not answer through the declared upstream-host contract\n' >&2
    status=1
  elif [[ "${knative_page,,}" != *"hello"* ]]; then
    printf 'Knative upstream host did not route to demo/hello\n' >&2
    status=1
  fi
fi
if (( status == 0 )); then
  printf 'INTAR_PROBE module-06-knative-scale-to-zero pass\n'
else
  printf 'INTAR_PROBE module-06-knative-scale-to-zero fail\n'
  last_failure="$(
    awk '/FAIL:/{ line=$0 } END{ print line }' <<<"${output}"
  )"
  if [[ -n "${last_failure}" ]]; then
    last_failure="${last_failure#*FAIL: }"
    printf 'INTAR_FAIL %.72s\n' "${last_failure}" >&2
  fi
fi
exit "${status}"
