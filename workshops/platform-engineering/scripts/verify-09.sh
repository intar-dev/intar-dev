#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/09-capstone/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  observability_status=0

  for app in victoria-metrics victoria-logs victoria-traces grafana otel-collector; do
    app_state=
    for attempt in $(seq 1 36); do
      app_state="$(kubectl -n argocd get application "${app}" \
        -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || true)"
      if [[ "${app_state##* }" == "Healthy" ]]; then
        break
      fi
      if [[ -z "${app_state}" && "${attempt}" -ge 2 ]]; then
        break
      fi
      sleep 5
    done
    if [[ "${app_state##* }" != "Healthy" ]]; then
      printf 'observability app %s is not Healthy (state: %s)\n' \
        "${app}" "${app_state:-missing}" >&2
      observability_status=1
    fi
  done

  for workload in \
    deployment/victoria-metrics \
    deployment/victoria-logs \
    deployment/victoria-traces \
    deployment/grafana \
    deployment/otel-collector-gateway \
    daemonset/otel-collector-agent; do
    if ! kubectl -n observability rollout status "${workload}" \
      --timeout=180s >/dev/null 2>&1; then
      printf 'observability workload %s is not ready\n' "${workload}" >&2
      observability_status=1
    fi
  done

  for backend in victoria-metrics victoria-logs victoria-traces; do
    if ! kubectl get --request-timeout=15s \
      --raw="/api/v1/namespaces/observability/services/${backend}:http/proxy/health" \
      >/dev/null 2>&1; then
      printf 'observability backend %s did not pass its service health check\n' \
        "${backend}" >&2
      observability_status=1
    fi
  done

  grafana_node_port="$(
    kubectl -n observability get service grafana-nodeport \
      -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}' 2>/dev/null || true
  )"
  if [[ "${grafana_node_port}" != "30030" ]]; then
    printf 'Grafana NodePort is %s instead of 30030\n' \
      "${grafana_node_port:-missing}" >&2
    observability_status=1
  fi

  if ! grafana_health="$(
    curl -fsS --max-time 15 http://localhost:30030/api/health
  )"; then
    printf 'Grafana did not answer through the declared workspace-app port 30030\n' >&2
    observability_status=1
  elif ! jq -e '.database == "ok"' <<<"${grafana_health}" >/dev/null; then
    printf 'Grafana API health did not report database=ok: %s\n' \
      "${grafana_health}" >&2
    observability_status=1
  fi

  check_grafana_datasource() {
    local name="$1" url="$2" filter="$3" response
    if ! response="$(curl -fsS --max-time 15 "${url}")"; then
      printf 'Grafana datasource %s is not queryable through the workspace-app port\n' \
        "${name}" >&2
      observability_status=1
    elif ! jq -e "${filter}" <<<"${response}" >/dev/null; then
      printf 'Grafana datasource %s returned an unexpected response: %s\n' \
        "${name}" "${response}" >&2
      observability_status=1
    fi
  }

  check_grafana_datasource \
    VictoriaMetrics \
    'http://localhost:30030/api/datasources/proxy/uid/victoriametrics/api/v1/query?query=up' \
    '.status == "success"'
  check_grafana_datasource \
    VictoriaLogs \
    'http://localhost:30030/api/datasources/uid/victorialogs/health' \
    '((.status // "") | ascii_downcase) == "ok"'

module09_trace_ready=0
module09_gallery_ready=0
module09_gallery_hard_failure=0
module09_outcome_status=0
module09_public_host=wa-workshop-probe.intar.app
module09_deadline=$((SECONDS + 60))

module09_portal_curl() {
  curl -sS --max-time 5 \
    -H "Host: ${module09_public_host}" \
    -H "X-Forwarded-Host: ${module09_public_host}" \
    -H 'X-Forwarded-Proto: https' \
    -H 'X-Forwarded-Port: 443' \
    "$@"
}

for module09_attempt in $(seq 1 12); do
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  if (( module09_trace_ready == 0 )); then
    module09_connected_trace="$(
      curl -fsS --max-time 5 \
        'http://localhost:30030/api/datasources/proxy/uid/victoriatraces/api/traces?service=cloudbox-portal&limit=20' \
        2>/dev/null || true
    )"
    if jq -e \
      'any(.data[]?;
        ([.processes[]?.serviceName] | unique) as $services |
        (["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"] -
          $services | length == 0))' \
      <<<"${module09_connected_trace}" >/dev/null 2>&1; then
      module09_trace_ready=1
    fi
  fi

  if (( module09_gallery_ready == 0 )); then
    module09_gallery_page="$(
      module09_portal_curl --fail \
        http://localhost:30600/gallery/grid 2>/dev/null || true
    )"
    if [[ "${module09_gallery_page}" == *"localhost:"* ]]; then
      printf 'Cloudbox gallery exposed a localhost URL through the workspace-app route\n' >&2
      module09_gallery_hard_failure=1
      module09_outcome_status=1
      break
    fi
    module09_gallery_url=$(
      printf '%s\n' "${module09_gallery_page}" |
        grep -Eo 'https://wa-workshop-probe\.intar\.app/__intar-s3/[^"<[:space:]]+' |
        sed 's/&amp;/\&/g' |
        sed -n '1p' || true
    )
    if [[ -n "${module09_gallery_url}" ]]; then
      module09_gallery_path="${module09_gallery_url#https://wa-workshop-probe.intar.app}"
      module09_gallery_file="$(mktemp)"
      if module09_portal_curl --fail \
        --output "${module09_gallery_file}" \
        "http://localhost:30600${module09_gallery_path}" \
        2>/dev/null &&
          [[ -s "${module09_gallery_file}" ]]; then
        module09_gallery_ready=1
      fi
      rm -f "${module09_gallery_file}"
    fi
  fi

  if (( module09_trace_ready == 1 && module09_gallery_ready == 1 )); then
    break
  fi
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  sleep 5
done

if (( module09_trace_ready == 0 && module09_gallery_hard_failure == 0 )); then
  printf 'module 09 connected upload trace did not converge within 60s\n' >&2
  module09_outcome_status=1
fi
if (( module09_gallery_ready == 0 && module09_gallery_hard_failure == 0 )); then
  printf 'Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within 60s\n' >&2
  module09_outcome_status=1
fi

  if (( module09_outcome_status != 0 )); then
    observability_status=1
  fi

  if ! gallery_s3_head_status="$(module09_portal_curl \
    --head \
    --output /dev/null \
    --write-out '%{http_code}' \
    http://localhost:30600/__intar-s3/app-assets/hello.txt)"; then
    printf 'Cloudbox S3 HEAD probe did not reach the workspace-app adapter\n' >&2
    observability_status=1
  elif [[ "${gallery_s3_head_status}" != 2* &&
          "${gallery_s3_head_status}" != "403" ]]; then
    printf 'Cloudbox S3 HEAD path returned HTTP %s instead of RustFS 2xx/403\n' \
      "${gallery_s3_head_status}" >&2
    observability_status=1
  fi

  if (( observability_status != 0 )); then
    status=1
  fi
fi
if (( status == 0 )); then
  printf 'INTAR_PROBE module-09-picture-pipeline-complete pass\n'
else
  printf 'INTAR_PROBE module-09-picture-pipeline-complete fail\n'
  last_failure="$(
    awk '/FAIL:/{ line=$0 } END{ print line }' <<<"${output}"
  )"
  if [[ -n "${last_failure}" ]]; then
    last_failure="${last_failure#*FAIL: }"
    printf 'INTAR_FAIL %.72s\n' "${last_failure}" >&2
  fi
fi
exit "${status}"
