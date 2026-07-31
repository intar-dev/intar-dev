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

  connected_trace=
  for _ in $(seq 1 24); do
    connected_trace="$(
      curl -fsS --max-time 15 \
        'http://localhost:30030/api/datasources/proxy/uid/victoriatraces/api/traces?service=cloudbox-portal&limit=20' \
        2>/dev/null || true
    )"
    if jq -e \
      'any(.data[]?;
        ([.processes[]?.serviceName] | unique) as $services |
        (["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"] -
          $services | length == 0))' \
      <<<"${connected_trace}" >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
  if ! jq -e \
    'any(.data[]?;
      ([.processes[]?.serviceName] | unique) as $services |
      (["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"] -
        $services | length == 0))' \
    <<<"${connected_trace}" >/dev/null 2>&1; then
    printf 'Grafana VictoriaTraces datasource did not expose one connected upload trace\n' >&2
    observability_status=1
  fi

  public_host=wa-workshop-probe.intar.app
  portal_workspace_app_curl() {
    curl -sS --max-time 15 \
      -H "Host: ${public_host}" \
      -H "X-Forwarded-Host: ${public_host}" \
      -H 'X-Forwarded-Proto: https' \
      -H 'X-Forwarded-Port: 443' \
      "$@"
  }

  if ! gallery_page="$(portal_workspace_app_curl \
    --fail \
    http://localhost:30600/gallery/grid)"; then
    printf 'Cloudbox gallery did not answer through the canonical workspace-app Host\n' >&2
    observability_status=1
  elif [[ "${gallery_page}" == *"localhost:"* ]]; then
    printf 'Cloudbox gallery exposed a localhost URL through the workspace-app route\n' >&2
    observability_status=1
  else
    gallery_s3_url=$(
      printf '%s\n' "${gallery_page}" |
        grep -Eo 'https://wa-workshop-probe\.intar\.app/__intar-s3/[^"<[:space:]]+' |
        sed 's/&amp;/\&/g' |
        sed -n '1p' || true
    )

    if [[ -n "${gallery_s3_url}" ]]; then
      gallery_s3_path="${gallery_s3_url#https://wa-workshop-probe.intar.app}"
      gallery_s3_file="$(mktemp)"
      if ! portal_workspace_app_curl \
        --fail \
        --output "${gallery_s3_file}" \
        "http://localhost:30600${gallery_s3_path}"; then
        printf 'Cloudbox gallery presigned S3 GET failed through /__intar-s3/\n' >&2
        observability_status=1
      elif [[ ! -s "${gallery_s3_file}" ]]; then
        printf 'Cloudbox gallery presigned S3 GET returned an empty object\n' >&2
        observability_status=1
      fi
      rm -f "${gallery_s3_file}"
    elif [[ "${gallery_page}" != *"Nothing here yet"* ]]; then
      printf 'Cloudbox gallery contained objects without a canonical /__intar-s3/ URL\n' >&2
      observability_status=1
    fi
  fi

  if ! gallery_s3_head_status="$(portal_workspace_app_curl \
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
fi
exit "${status}"
