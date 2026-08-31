#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: tools/deploy/deploy-web.sh <wrangler-config> <database-id> <session-namespace-id> <secrets-file> <evidence.json>" >&2
  exit 64
fi

readonly config="$1"
readonly database_id="$2"
readonly session_namespace_id="$3"
readonly secrets_file="$4"
readonly evidence="$5"
readonly worker_name="intar-dev"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly deploy_label="${WEB_DEPLOY_LABEL:-standard}"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-web-deploy-${GITHUB_RUN_ID:-local}-${deploy_label}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly before_health="${runtime_root}/before-health.json"
readonly deploy_output="${runtime_root}/wrangler-deploy.ndjson"
readonly deploy_result="${runtime_root}/wrangler-deploy.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly propagation_attempts="${runtime_root}/propagation-attempts.ndjson"

mkdir -p "${runtime_root}"
test -f "${config}"
test -f "${secrets_file}"
test ! -e "${evidence}"
[[ "${database_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
[[ "${session_namespace_id}" =~ ^[0-9a-f]{32}$ ]]
[[ "${deploy_label}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GITHUB_SHA:-}"
test -n "${GITHUB_RUN_ID:-}"
test -n "${GITHUB_RUN_ATTEMPT:-}"

config_dir="$(cd "$(dirname "${config}")" && pwd)"
assets_relative="$(jq -er '.assets.directory' "${config}")"
assets_dir="$(cd "${config_dir}" && cd "${assets_relative}" && pwd)"
favicon_path="${assets_dir}/favicon.svg"
test -f "${favicon_path}"
favicon_sha256="$(sha256sum "${favicon_path}" | cut -d ' ' -f 1)"
[[ "${favicon_sha256}" =~ ^[0-9a-f]{64}$ ]]

jq -e \
  --arg database_id "${database_id}" \
  --arg session_namespace_id "${session_namespace_id}" '
    ([.d1_databases[]? | select(.binding == "DB")]) as $databases |
    ([.kv_namespaces[]? | select(.binding == "SESSION")]) as $sessions |
    ($databases | length) == 1 and
    $databases[0].database_id == $database_id and
    ($sessions | length) == 1 and
    $sessions[0].id == $session_namespace_id and
    .assets.run_worker_first == ["/api/*"] and
    (.migrations | type) == "array" and
    (.migrations | length) >= 1 and
    (.migrations[-1].tag | type) == "string"
  ' "${config}" >/dev/null

target_maintenance_value="$(jq -er '.vars.CONTROL_PLANE_MAINTENANCE // "off"' "${config}")"
case "${target_maintenance_value}" in
  on) target_mode=maintenance ;;
  off) target_mode=open ;;
  *) echo "invalid target CONTROL_PLANE_MAINTENANCE value" >&2; exit 1 ;;
esac

probe_health() {
  local label="$1"
  local output="$2"
  local expected_mode="$3"
  local full_check="$4"
  local root_body="${runtime_root}/${label}-root.html"
  local maintenance_body="${runtime_root}/${label}-maintenance.json"
  local health_body="${runtime_root}/${label}-health.json"
  local favicon_body="${runtime_root}/${label}-favicon.svg"
  local root_status
  local maintenance_status
  local maintenance_code
  local health_status=""
  local health_state=""
  local favicon_status=""
  local observed_favicon_sha256=""
  local healthy=false

  root_status="$({ curl --silent --show-error --connect-timeout 2 --max-time 8 \
    --header 'Cache-Control: no-cache' --output "${root_body}" \
    --write-out '%{http_code}' https://intar.dev/; } || true)"
  maintenance_status="$({ curl --silent --show-error --connect-timeout 2 --max-time 8 \
    --header 'Accept: application/json' --header 'Cache-Control: no-cache' \
    --output "${maintenance_body}" --write-out '%{http_code}' \
    https://intar.dev/api/control-plane-maintenance-probe; } || true)"
  maintenance_code="$(jq -r '.code // empty' "${maintenance_body}" 2>/dev/null || true)"

  if [ "${expected_mode}" = maintenance ]; then
    if [ "${root_status}" = 503 ] && [ "${maintenance_status}" = 503 ] && \
      [ "${maintenance_code}" = maintenance ]; then
      healthy=true
    fi
  elif [ "${expected_mode}" = open ]; then
    if [ "${full_check}" = true ]; then
      health_status="$({ curl --silent --show-error --connect-timeout 2 --max-time 8 \
        --header 'Accept: application/json' --header 'Cache-Control: no-cache' \
        --output "${health_body}" --write-out '%{http_code}' \
        https://intar.dev/api/health; } || true)"
      health_state="$(jq -r '.status // empty' "${health_body}" 2>/dev/null || true)"
      favicon_status="$({ curl --silent --show-error --connect-timeout 2 --max-time 8 \
        --header 'Cache-Control: no-cache' --output "${favicon_body}" \
        --write-out '%{http_code}' https://intar.dev/favicon.svg; } || true)"
      if [ -f "${favicon_body}" ]; then
        observed_favicon_sha256="$(sha256sum "${favicon_body}" | cut -d ' ' -f 1)"
      fi
    fi
    if [ "${root_status}" = 200 ] && [ "${maintenance_status}" = 404 ] && \
      { [ "${full_check}" = false ] || \
        { [ "${health_status}" = 200 ] && [ "${health_state}" = ok ] && \
          [ "${favicon_status}" = 200 ] && \
          [ "${observed_favicon_sha256}" = "${favicon_sha256}" ]; }; }; then
      healthy=true
    fi
  fi

  jq -n \
    --arg expected_mode "${expected_mode}" \
    --arg root_status "${root_status}" \
    --arg maintenance_status "${maintenance_status}" \
    --arg maintenance_code "${maintenance_code}" \
    --arg health_status "${health_status}" \
    --arg health_state "${health_state}" \
    --arg favicon_status "${favicon_status}" \
    --arg expected_favicon_sha256 "${favicon_sha256}" \
    --arg observed_favicon_sha256 "${observed_favicon_sha256}" \
    --argjson full_check "${full_check}" \
    --argjson healthy "${healthy}" '
      {
        expected_mode: $expected_mode,
        full_check: $full_check,
        root_status: $root_status,
        maintenance_status: $maintenance_status,
        maintenance_code: (if $maintenance_code == "" then null else $maintenance_code end),
        health_status: (if $health_status == "" then null else $health_status end),
        health_state: (if $health_state == "" then null else $health_state end),
        favicon_status: (if $favicon_status == "" then null else $favicon_status end),
        expected_favicon_sha256: $expected_favicon_sha256,
        observed_favicon_sha256: (if $observed_favicon_sha256 == "" then null else $observed_favicon_sha256 end),
        healthy: $healthy
      }
    ' > "${output}"
  jq -e '.healthy == true' "${output}" >/dev/null
}

bunx wrangler deployments status --name "${worker_name}" --json \
  > "${before_deployment}"
before_version_id="$(jq -er '
  .versions | select(length == 1) | .[0] |
  select(.percentage == 100) | .version_id
' "${before_deployment}")"
[[ "${before_version_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
bunx wrangler versions view "${before_version_id}" \
  --name "${worker_name}" --json > "${before_version}"
bun "${repository_root}/tools/deploy/worker-version.ts" \
  "${before_deployment}" "${before_version}" \
  "${database_id}" "${session_namespace_id}" "${before_version_id}" >/dev/null
before_maintenance_value="$(jq -r '
  [.resources.bindings[] | select(
    .type == "plain_text" and .name == "CONTROL_PLANE_MAINTENANCE"
  )] |
  if length == 0 then "off"
  elif length == 1 then .[0].text
  else "invalid"
  end
' "${before_version}")"
case "${before_maintenance_value}" in
  on) before_mode=maintenance ;;
  off) before_mode=open ;;
  *) echo "invalid active CONTROL_PLANE_MAINTENANCE binding" >&2; exit 1 ;;
esac
probe_health before "${before_health}" "${before_mode}" false

test ! -e "${deploy_output}"
WRANGLER_OUTPUT_FILE_PATH="${deploy_output}" \
  bunx wrangler deploy \
    --name "${worker_name}" \
    --config "${config}" \
    --tag "web-${GITHUB_SHA:0:12}-${deploy_label}" \
    --message "Automatic web deployment for ${GITHUB_SHA}" \
    --secrets-file "${secrets_file}" \
    --strict \
    --experimental-provision=false \
    --autoconfig=false
bun "${repository_root}/tools/deploy/wrangler-output.ts" \
  "${deploy_output}" "${worker_name}" > "${deploy_result}"
deployed_version_id="$(jq -er '.versionId' "${deploy_result}")"
[[ "${deployed_version_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]

active_version_proven=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  bunx wrangler deployments status --name "${worker_name}" --json \
    > "${after_deployment}"
  if jq -e --arg version_id "${deployed_version_id}" '
    .versions | length == 1 and
    .[0].version_id == $version_id and
    .[0].percentage == 100
  ' "${after_deployment}" >/dev/null; then
    active_version_proven=true
    break
  fi
  if [ "${attempt}" -lt 10 ]; then sleep 2; fi
done
test "${active_version_proven}" = true
bunx wrangler versions view "${deployed_version_id}" \
  --name "${worker_name}" --json > "${after_version}"
bun "${repository_root}/tools/deploy/worker-version.ts" \
  "${after_deployment}" "${after_version}" \
  "${database_id}" "${session_namespace_id}" "${deployed_version_id}" >/dev/null
jq -e '
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "STARGATE_EGRESS_IPV4_CIDRS"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1"
  )] | length) == 1 and
  ([.resources.bindings[] | select(.name == "BETTER_AUTH_TRUSTED_ORIGINS")]
    | length) == 0
' "${after_version}" >/dev/null
jq -e --arg migration_tag "$(jq -er '.resources.script_runtime.migration_tag' "${after_version}")" '
  .migrations[-1].tag == $migration_tag
' "${config}" >/dev/null

: > "${propagation_attempts}"
propagation_proven=false
propagation_observed_attempt=0
propagation_consecutive_healthy=0
propagation_max_attempts=20
propagation_required_consecutive_healthy=5
propagation_retry_seconds=2
for attempt in $(seq 1 "${propagation_max_attempts}"); do
  health_state="${runtime_root}/after-health-${attempt}.json"
  root_healthy=false
  if probe_health "after-${attempt}" "${health_state}" "${target_mode}" true; then
    root_healthy=true
    propagation_consecutive_healthy="$((propagation_consecutive_healthy + 1))"
  else
    propagation_consecutive_healthy=0
  fi
  jq -cn \
    --argjson attempt "${attempt}" \
    --argjson root_healthy "${root_healthy}" \
    --argjson consecutive_healthy "${propagation_consecutive_healthy}" \
    --slurpfile observed "${health_state}" \
    '{attempt: $attempt, root_healthy: $root_healthy, consecutive_healthy: $consecutive_healthy, observed: $observed[0]}' \
    >> "${propagation_attempts}"
  if [ "${propagation_consecutive_healthy}" -ge \
    "${propagation_required_consecutive_healthy}" ]; then
    propagation_proven=true
    propagation_observed_attempt="${attempt}"
    break
  fi
  if [ "${attempt}" -lt "${propagation_max_attempts}" ]; then
    sleep "${propagation_retry_seconds}"
  fi
done
test "${propagation_proven}" = true

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --argjson run_attempt "${GITHUB_RUN_ATTEMPT}" \
  --arg deploy_label "${deploy_label}" \
  --arg before_version_id "${before_version_id}" \
  --arg deployed_version_id "${deployed_version_id}" \
  --arg database_id "${database_id}" \
  --arg session_namespace_id "${session_namespace_id}" \
  --arg target_mode "${target_mode}" \
  --argjson propagation_max_attempts "${propagation_max_attempts}" \
  --argjson propagation_required_consecutive_healthy "${propagation_required_consecutive_healthy}" \
  --argjson propagation_observed_consecutive_healthy "${propagation_consecutive_healthy}" \
  --argjson propagation_retry_seconds "${propagation_retry_seconds}" \
  --argjson propagation_observed_attempt "${propagation_observed_attempt}" \
  --slurpfile before_health "${before_health}" \
  --rawfile propagation_attempts_ndjson "${propagation_attempts}" \
  --rawfile wrangler_deploy_ndjson "${deploy_output}" '
    {
      schema_version: 1,
      operation: "deploy-web",
      source_sha: $source_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      deploy_label: $deploy_label,
      before_version_id: $before_version_id,
      deployed_version_id: $deployed_version_id,
      database_id: $database_id,
      session_namespace_id: $session_namespace_id,
      target_mode: $target_mode,
      exact_version_active: true,
      active_runtime_bindings_proven: true,
      runtime_secret_bindings_proven: true,
      full_configuration_deployed: true,
      propagation_max_attempts: $propagation_max_attempts,
      propagation_required_consecutive_healthy: $propagation_required_consecutive_healthy,
      propagation_observed_consecutive_healthy: $propagation_observed_consecutive_healthy,
      propagation_retry_seconds: $propagation_retry_seconds,
      propagation_observed_attempt: $propagation_observed_attempt,
      live_health_proven: true,
      before_health: $before_health[0],
      propagation_attempts_ndjson: $propagation_attempts_ndjson,
      wrangler_deploy_ndjson: $wrangler_deploy_ndjson
    }
  ' > "${evidence}"
jq -e '
  .schema_version == 1 and
  .operation == "deploy-web" and
  .deployed_version_id != .before_version_id and
  .exact_version_active == true and
  .active_runtime_bindings_proven == true and
  .runtime_secret_bindings_proven == true and
  .full_configuration_deployed == true and
  .live_health_proven == true and
  .propagation_observed_consecutive_healthy >=
    .propagation_required_consecutive_healthy and
  (.propagation_attempts_ndjson | contains("\"root_healthy\":true")) and
  (.wrangler_deploy_ndjson | contains("\"type\":\"deploy\""))
' "${evidence}" >/dev/null
