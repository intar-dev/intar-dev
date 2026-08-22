#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: tools/deploy/activate-web-version.sh <wrangler-config> <current-database-id> <target-database-id> <session-namespace-id> <secrets-file> <evidence.json> <expected-current-mode>" >&2
  exit 64
fi

readonly config="$1"
readonly current_database_id="$2"
readonly target_database_id="$3"
readonly session_namespace_id="$4"
readonly secrets_file="$5"
readonly evidence="$6"
readonly expected_current_mode="$7"
readonly worker_name="intar-dev"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly activation_label="${WEB_ACTIVATION_LABEL:-standard}"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-web-deploy-${GITHUB_RUN_ID:-local}-${activation_label}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly before_health="${runtime_root}/before-health.json"
readonly upload_output="${runtime_root}/wrangler-version-upload.ndjson"
readonly upload_result="${runtime_root}/wrangler-version-upload.json"
readonly uploaded_version="${runtime_root}/uploaded-version.json"
readonly after_upload_deployment="${runtime_root}/after-upload-deployment.json"
readonly deploy_output="${runtime_root}/wrangler-version-deploy.ndjson"
readonly deploy_result="${runtime_root}/wrangler-version-deploy.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly rollback_deployment="${runtime_root}/rollback-deployment.json"
readonly rollback_evidence="${runtime_root}/rollback-evidence.json"
readonly rollback_attempts="${runtime_root}/rollback-attempts.ndjson"
readonly rollback_propagation_attempts="${runtime_root}/rollback-propagation-attempts.ndjson"
readonly propagation_attempts="${runtime_root}/propagation-attempts.ndjson"
readonly attempt_evidence="${runtime_root}/attempt.json"

mkdir -p "${runtime_root}"
test -f "${config}"
test -f "${secrets_file}"
[[ "${current_database_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
[[ "${target_database_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
[[ "${session_namespace_id}" =~ ^[0-9a-f]{32}$ ]]
[[ "${activation_label}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
case "${expected_current_mode}" in
  maintenance|open) ;;
  *) echo "expected current mode must be maintenance or open" >&2; exit 64 ;;
esac
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GITHUB_SHA:-}"
test -n "${GITHUB_RUN_ID:-}"
test -n "${GITHUB_RUN_ATTEMPT:-}"

probe_root_health() {
  local label="$1"
  local output="$2"
  local expected_mode="$3"
  local root_headers="${runtime_root}/${label}-root-headers.txt"
  local root_body="${runtime_root}/${label}-root-body.txt"
  local maintenance_headers="${runtime_root}/${label}-maintenance-headers.txt"
  local maintenance_body="${runtime_root}/${label}-maintenance-body.json"
  local root_status
  local maintenance_status=""
  local maintenance_code=""
  local healthy=false

  root_status="$({ curl --silent --show-error --connect-timeout 1 --max-time 5 \
    --header 'Cache-Control: no-cache' --output "${root_body}" \
    --dump-header "${root_headers}" --write-out '%{http_code}' \
    https://intar.dev/; } || true)"
  if [ "${expected_mode}" = maintenance ]; then
    maintenance_status="$({ curl --silent --show-error --connect-timeout 1 --max-time 5 \
      --header 'Accept: application/json' --header 'Cache-Control: no-cache' \
      --output "${maintenance_body}" --dump-header "${maintenance_headers}" \
      --write-out '%{http_code}' \
      https://intar.dev/api/control-plane-maintenance-probe; } || true)"
    maintenance_code="$(jq -r '.code // empty' "${maintenance_body}" 2>/dev/null || true)"
    if [ "${root_status}" = 503 ] && [ "${maintenance_status}" = 503 ] && \
      [ "${maintenance_code}" = maintenance ]; then
      healthy=true
    fi
  elif [ "${expected_mode}" = open ] && [ "${root_status}" = 200 ]; then
    healthy=true
  fi
  jq -n \
    --arg root_status "${root_status}" \
    --arg expected_mode "${expected_mode}" \
    --arg maintenance_status "${maintenance_status}" \
    --arg maintenance_code "${maintenance_code}" \
    --argjson healthy "${healthy}" \
    --arg url "https://intar.dev/" \
    '{url: $url, expected_mode: $expected_mode, root_status: $root_status, maintenance_status: (if $maintenance_status == "" then null else $maintenance_status end), maintenance_code: (if $maintenance_code == "" then null else $maintenance_code end), healthy: $healthy}' \
    > "${output}"
  jq -e '.healthy == true' "${output}" >/dev/null
}

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --arg run_attempt "${GITHUB_RUN_ATTEMPT}" \
  --arg current_database_id "${current_database_id}" \
  --arg target_database_id "${target_database_id}" \
  --arg session_namespace_id "${session_namespace_id}" \
  --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schema_version: 1, operation: "activate-exact-web-version-attempt", state: "started", source_sha: $source_sha, run_id: $run_id, run_attempt: ($run_attempt | tonumber), current_database_id: $current_database_id, target_database_id: $target_database_id, session_namespace_id: $session_namespace_id, started_at: $started_at}' \
  > "${attempt_evidence}"

jq -e \
  --arg target_database_id "${target_database_id}" \
  --arg session_namespace_id "${session_namespace_id}" '
    ([.d1_databases[]? | select(.binding == "DB")]) as $databases |
    ([.kv_namespaces[]? | select(.binding == "SESSION")]) as $sessions |
    ($databases | length) == 1 and
    $databases[0].database_id == $target_database_id and
    ($sessions | length) == 1 and
    $sessions[0].id == $session_namespace_id and
    (.migrations | type) == "array" and
    (.migrations | length) >= 1 and
    (.migrations[-1].tag | type) == "string"
  ' "${config}" >/dev/null
target_maintenance_value="$(jq -er '.vars.CONTROL_PLANE_MAINTENANCE // "off"' "${config}")"
case "${target_maintenance_value}" in
  on) target_health_mode=maintenance ;;
  off) target_health_mode=open ;;
  *) echo "invalid target CONTROL_PLANE_MAINTENANCE value" >&2; exit 1 ;;
esac

bunx wrangler deployments status --name "${worker_name}" --json \
  > "${before_deployment}"
before_deployment_id="$(jq -er '.id' "${before_deployment}")"
before_version_id="$(jq -er '
  .versions | select(length == 1) | .[0] |
  select(.percentage == 100) | .version_id
' "${before_deployment}")"
[[ "${before_deployment_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
[[ "${before_version_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
bunx wrangler versions view "${before_version_id}" \
  --name "${worker_name}" --json > "${before_version}"
bun "${repository_root}/tools/deploy/worker-version.ts" \
  active-runtime-bindings "${before_deployment}" "${before_version}" \
  "${current_database_id}" "${session_namespace_id}" "${before_version_id}" \
  >/dev/null
jq -e --arg version_id "${before_version_id}" '
  .id == $version_id and
  (.resources.script_runtime.migration_tag | type) == "string" and
  ([.resources.bindings[] | select(
    .type == "durable_object_namespace" and
    .name == "HOST_RUNTIME" and
    .class_name == "HostRuntimeDO"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "STARGATE_EGRESS_IPV4_CIDRS"
  )] | length) == 1
' "${before_version}" >/dev/null
jq -e --arg migration_tag "$(jq -er '.resources.script_runtime.migration_tag' "${before_version}")" '
  .migrations[-1].tag == $migration_tag
' "${config}" >/dev/null
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
  on) before_health_mode=maintenance ;;
  off) before_health_mode=open ;;
  *) echo "invalid active CONTROL_PLANE_MAINTENANCE binding" >&2; exit 1 ;;
esac
test "${before_health_mode}" = "${expected_current_mode}"
probe_root_health "before" "${before_health}" "${before_health_mode}"

restore_required=false
uploaded_version_id=""

restore_previous_on_exit() {
  local exit_status="$?"
  trap - EXIT INT TERM
  if [ "${exit_status}" -eq 0 ] || [ "${restore_required}" != true ]; then
    exit "${exit_status}"
  fi

  set +e
  : > "${rollback_attempts}"
  : > "${rollback_propagation_attempts}"
  rollback_control_plane_proven=false
  rollback_health_proven=false
  rollback_deployment_id=""
  rollback_command_attempts=0
  rollback_reconcile_attempts=0
  for attempt in 1 2 3 4 5 6 7; do
    rollback_reconcile_attempts="${attempt}"
    status_path="${runtime_root}/rollback-deployment-${attempt}.json"
    bunx wrangler deployments status --name "${worker_name}" --json \
      > "${status_path}"
    status_code="$?"
    observed_version_id=""
    observed_deployment_id=""
    if [ "${status_code}" -eq 0 ]; then
      observed_version_id="$(jq -r '
        .versions | select(length == 1) | .[0] |
        select(.percentage == 100) | .version_id // empty
      ' "${status_path}")"
      observed_deployment_id="$(jq -r '.id // empty' "${status_path}")"
      if [ "${observed_version_id}" = "${before_version_id}" ]; then
        cp "${status_path}" "${rollback_deployment}"
        rollback_deployment_id="${observed_deployment_id}"
        rollback_control_plane_proven=true
        jq -cn \
          --argjson attempt "${attempt}" \
          --argjson status_code "${status_code}" \
          --arg observed_version_id "${observed_version_id}" \
          --arg observed_deployment_id "${observed_deployment_id}" \
          '{attempt: $attempt, phase: "reconcile", status_code: $status_code, observed_version_id: $observed_version_id, observed_deployment_id: $observed_deployment_id, exact_previous_version_active: true}' \
          >> "${rollback_attempts}"
        break
      fi
    fi

    if [ "${attempt}" -eq 7 ]; then
      jq -cn \
        --argjson attempt "${attempt}" \
        --argjson status_code "${status_code}" \
        --arg observed_version_id "${observed_version_id}" \
        --arg observed_deployment_id "${observed_deployment_id}" \
        '{attempt: $attempt, phase: "reconcile", status_code: $status_code, observed_version_id: (if $observed_version_id == "" then null else $observed_version_id end), observed_deployment_id: (if $observed_deployment_id == "" then null else $observed_deployment_id end), exact_previous_version_active: false}' \
        >> "${rollback_attempts}"
      break
    fi

    rollback_command_attempts="$((rollback_command_attempts + 1))"
    rollback_output="${runtime_root}/wrangler-version-rollback-${attempt}.ndjson"
    rollback_result="${runtime_root}/wrangler-version-rollback-${attempt}.json"
    test ! -e "${rollback_output}"
    WRANGLER_OUTPUT_FILE_PATH="${rollback_output}" \
      bunx wrangler versions deploy "${before_version_id}@100%" \
        --name "${worker_name}" \
        --message "Restore previous web version after run ${GITHUB_RUN_ID} attempt ${attempt}" \
        --yes
    command_status="$?"
    receipt_status=-1
    receipt_deployment_id=""
    if [ "${command_status}" -eq 0 ]; then
      bun "${repository_root}/tools/deploy/wrangler-output.ts" version-deploy \
        "${rollback_output}" "${worker_name}" > "${rollback_result}"
      receipt_status="$?"
      if [ "${receipt_status}" -eq 0 ]; then
        receipt_deployment_id="$(jq -r '.deploymentId // empty' "${rollback_result}")"
      fi
    fi
    jq -cn \
      --argjson attempt "${attempt}" \
      --argjson status_code "${status_code}" \
      --arg observed_version_id "${observed_version_id}" \
      --arg observed_deployment_id "${observed_deployment_id}" \
      --argjson command_status "${command_status}" \
      --argjson receipt_status "${receipt_status}" \
      --arg receipt_deployment_id "${receipt_deployment_id}" \
      '{attempt: $attempt, phase: "restore", status_code: $status_code, observed_version_id: (if $observed_version_id == "" then null else $observed_version_id end), observed_deployment_id: (if $observed_deployment_id == "" then null else $observed_deployment_id end), exact_previous_version_active: false, command_status: $command_status, receipt_status: $receipt_status, receipt_deployment_id: (if $receipt_deployment_id == "" then null else $receipt_deployment_id end)}' \
      >> "${rollback_attempts}"
    sleep 2
  done

  rollback_propagation_observed_attempt=0
  if [ "${rollback_control_plane_proven}" = true ]; then
    for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
      rollback_state="${runtime_root}/rollback-health-${attempt}.json"
      probe_root_health "rollback-${attempt}" "${rollback_state}" \
        "${before_health_mode}"
      probe_status="$?"
      root_healthy=false
      if [ "${probe_status}" -eq 0 ]; then
        root_healthy=true
        rollback_health_proven=true
        rollback_propagation_observed_attempt="${attempt}"
      fi
      jq -cn \
        --argjson attempt "${attempt}" \
        --argjson probe_status "${probe_status}" \
        --argjson root_healthy "${root_healthy}" \
        --slurpfile observed "${rollback_state}" \
        '{attempt: $attempt, probe_status: $probe_status, root_healthy: $root_healthy, observed: $observed[0]}' \
        >> "${rollback_propagation_attempts}"
      if [ "${root_healthy}" = true ]; then break; fi
      if [ "${attempt}" -lt 12 ]; then sleep 2; fi
    done
  fi
  rollback_proven=false
  if [ "${rollback_control_plane_proven}" = true ] && \
    [ "${rollback_health_proven}" = true ]; then
    rollback_proven=true
  fi
  jq -n \
    --arg source_sha "${GITHUB_SHA}" \
    --arg run_id "${GITHUB_RUN_ID}" \
    --arg before_version_id "${before_version_id}" \
    --arg attempted_version_id "${uploaded_version_id}" \
    --arg current_database_id "${current_database_id}" \
    --arg target_database_id "${target_database_id}" \
    --arg rollback_deployment_id "${rollback_deployment_id}" \
    --argjson original_exit_status "${exit_status}" \
    --argjson rollback_command_attempts "${rollback_command_attempts}" \
    --argjson rollback_reconcile_attempts "${rollback_reconcile_attempts}" \
    --argjson rollback_control_plane_proven "${rollback_control_plane_proven}" \
    --argjson rollback_health_proven "${rollback_health_proven}" \
    --argjson rollback_propagation_observed_attempt "${rollback_propagation_observed_attempt}" \
    --argjson rollback_proven "${rollback_proven}" \
    --slurpfile before_health "${before_health}" \
    --rawfile rollback_attempts_ndjson "${rollback_attempts}" \
    --rawfile rollback_propagation_attempts_ndjson "${rollback_propagation_attempts}" \
    '{schema_version: 1, operation: "restore-exact-web-version", source_sha: $source_sha, run_id: $run_id, original_exit_status: $original_exit_status, before_version_id: $before_version_id, attempted_version_id: (if $attempted_version_id == "" then null else $attempted_version_id end), current_database_id: $current_database_id, target_database_id: $target_database_id, rollback_command_attempts: $rollback_command_attempts, rollback_reconcile_attempts: $rollback_reconcile_attempts, rollback_deployment_id: (if $rollback_deployment_id == "" then null else $rollback_deployment_id end), rollback_control_plane_proven: $rollback_control_plane_proven, rollback_health_proven: $rollback_health_proven, rollback_propagation_max_attempts: 12, rollback_propagation_retry_seconds: 2, rollback_propagation_observed_attempt: $rollback_propagation_observed_attempt, rollback_proven: $rollback_proven, before_health: $before_health[0], rollback_attempts_ndjson: $rollback_attempts_ndjson, rollback_propagation_attempts_ndjson: $rollback_propagation_attempts_ndjson, routes_mutated: false, crons_mutated: false, durable_object_lifecycle_mutated: false}' \
    > "${rollback_evidence}"
  set -e
  exit "${exit_status}"
}

trap restore_previous_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

test ! -e "${upload_output}"
WRANGLER_OUTPUT_FILE_PATH="${upload_output}" \
  bunx wrangler versions upload \
    --name "${worker_name}" \
    --config "${config}" \
    --tag "web-deploy-${GITHUB_RUN_ID}" \
    --message "Web deployment for run ${GITHUB_RUN_ID}" \
    --secrets-file "${secrets_file}" \
    --strict \
    --experimental-provision=false
bun "${repository_root}/tools/deploy/wrangler-output.ts" version-upload \
  "${upload_output}" "${worker_name}" > "${upload_result}"
uploaded_version_id="$(jq -er '.versionId' "${upload_result}")"
[[ "${uploaded_version_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
test "${uploaded_version_id}" != "${before_version_id}"

bunx wrangler versions view "${uploaded_version_id}" \
  --name "${worker_name}" --json > "${uploaded_version}"
bun "${repository_root}/tools/deploy/worker-version.ts" \
  version-runtime-bindings "${uploaded_version}" "${target_database_id}" \
  "${session_namespace_id}" "${uploaded_version_id}" >/dev/null
jq -e '
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "STARGATE_EGRESS_IPV4_CIDRS"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .type == "secret_text" and .name == "OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1"
  )] | length) == 1 and
  ([.resources.bindings[] | select(
    .name == "BETTER_AUTH_TRUSTED_ORIGINS"
  )] | length) == 0
' "${uploaded_version}" >/dev/null
jq -s -e '
  def durable_object_bindings:
    [.resources.bindings[] | select(.type == "durable_object_namespace") | {
      name,
      namespace_id,
      class_name,
      script_name: (.script_name // null),
      environment: (.environment // null)
    }] | sort_by(.name, .namespace_id, .class_name, .script_name, .environment);
  .[0] as $reference |
  .[1] as $uploaded |
  ($reference | durable_object_bindings) ==
    ($uploaded | durable_object_bindings) and
  $uploaded.resources.script_runtime.migration_tag ==
    $reference.resources.script_runtime.migration_tag
' "${before_version}" "${uploaded_version}" >/dev/null

bunx wrangler deployments status --name "${worker_name}" --json \
  > "${after_upload_deployment}"
jq -e \
  --arg deployment_id "${before_deployment_id}" \
  --arg version_id "${before_version_id}" '
    .id == $deployment_id and
    (.versions | length) == 1 and
    .versions[0].version_id == $version_id and
    .versions[0].percentage == 100
  ' "${after_upload_deployment}" >/dev/null

# From this point onward even an ambiguous CLI failure may have switched
# traffic, so the EXIT trap restores the exact version observed above.
restore_required=true
test ! -e "${deploy_output}"
WRANGLER_OUTPUT_FILE_PATH="${deploy_output}" \
  bunx wrangler versions deploy "${uploaded_version_id}@100%" \
    --name "${worker_name}" \
    --message "Activate web version for run ${GITHUB_RUN_ID}" \
    --yes
bun "${repository_root}/tools/deploy/wrangler-output.ts" version-deploy \
  "${deploy_output}" "${worker_name}" > "${deploy_result}"
deployed_deployment_id="$(jq -er '.deploymentId' "${deploy_result}")"

bunx wrangler deployments status --name "${worker_name}" --json \
  > "${after_deployment}"
bunx wrangler versions view "${uploaded_version_id}" \
  --name "${worker_name}" --json > "${after_version}"
test "$(jq -er '.id' "${after_deployment}")" = "${deployed_deployment_id}"
bun "${repository_root}/tools/deploy/worker-version.ts" \
  active-runtime-bindings "${after_deployment}" "${after_version}" \
  "${target_database_id}" "${session_namespace_id}" "${uploaded_version_id}" \
  >/dev/null

: > "${propagation_attempts}"
propagation_proven=false
propagation_observed_attempt=0
for attempt in $(seq 1 12); do
  health_state="${runtime_root}/after-health-${attempt}.json"
  root_healthy=false
  if probe_root_health "after-${attempt}" "${health_state}" \
    "${target_health_mode}"; then
    root_healthy=true
  fi
  jq -cn \
    --argjson attempt "${attempt}" \
    --argjson root_healthy "${root_healthy}" \
    --slurpfile observed "${health_state}" \
    '{attempt: $attempt, root_healthy: $root_healthy, observed: $observed[0]}' \
    >> "${propagation_attempts}"
  if [ "${root_healthy}" = true ]; then
    propagation_proven=true
    propagation_observed_attempt="${attempt}"
    break
  fi
  if [ "${attempt}" -lt 12 ]; then sleep 2; fi
done
test "${propagation_proven}" = true

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --argjson run_attempt "${GITHUB_RUN_ATTEMPT}" \
  --arg before_deployment_id "${before_deployment_id}" \
  --arg before_version_id "${before_version_id}" \
  --arg uploaded_version_id "${uploaded_version_id}" \
  --arg deployed_deployment_id "${deployed_deployment_id}" \
  --arg current_database_id "${current_database_id}" \
  --arg target_database_id "${target_database_id}" \
  --arg session_namespace_id "${session_namespace_id}" \
  --argjson propagation_observed_attempt "${propagation_observed_attempt}" \
  --slurpfile before_health "${before_health}" \
  --rawfile propagation_attempts_ndjson "${propagation_attempts}" \
  --rawfile wrangler_version_upload_ndjson "${upload_output}" \
  --rawfile wrangler_version_deploy_ndjson "${deploy_output}" '
    {
      schema_version: 1,
      operation: "activate-exact-web-version",
      source_sha: $source_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      before_deployment_id: $before_deployment_id,
      before_version_id: $before_version_id,
      reference_version_id: $before_version_id,
      uploaded_version_id: $uploaded_version_id,
      deployed_deployment_id: $deployed_deployment_id,
      current_database_id: $current_database_id,
      target_database_id: $target_database_id,
      database_binding_changed: ($current_database_id != $target_database_id),
      session_namespace_id: $session_namespace_id,
      current_active_version_used_as_reference: true,
      before_health_proven: true,
      uploaded_runtime_bindings_proven: true,
      upload_did_not_activate: true,
      exact_version_deployed: true,
      active_runtime_bindings_proven: true,
      runtime_secret_binding_proven: true,
      durable_object_binding_set_unchanged: true,
      durable_object_migration_tag_unchanged: true,
      propagation_max_attempts: 12,
      propagation_retry_seconds: 2,
      propagation_observed_attempt: $propagation_observed_attempt,
      after_health_proven: true,
      before_health: $before_health[0],
      propagation_attempts_ndjson: $propagation_attempts_ndjson,
      routes_mutated: false,
      crons_mutated: false,
      durable_object_lifecycle_mutated: false,
      wrangler_version_upload_ndjson: $wrangler_version_upload_ndjson,
      wrangler_version_deploy_ndjson: $wrangler_version_deploy_ndjson
    }
  ' > "${evidence}"
jq -e \
  --arg current_database_id "${current_database_id}" \
  --arg target_database_id "${target_database_id}" \
  --arg session_namespace_id "${session_namespace_id}" '
    .schema_version == 1 and
    .operation == "activate-exact-web-version" and
    .current_database_id == $current_database_id and
    .target_database_id == $target_database_id and
    .database_binding_changed == ($current_database_id != $target_database_id) and
    .session_namespace_id == $session_namespace_id and
    .uploaded_version_id != .before_version_id and
    .reference_version_id == .before_version_id and
    .current_active_version_used_as_reference == true and
    .before_health_proven == true and
    .uploaded_runtime_bindings_proven == true and
    .upload_did_not_activate == true and
    .exact_version_deployed == true and
    .active_runtime_bindings_proven == true and
    .runtime_secret_binding_proven == true and
    .durable_object_binding_set_unchanged == true and
    .durable_object_migration_tag_unchanged == true and
    .after_health_proven == true and
    .propagation_observed_attempt >= 1 and
    .propagation_observed_attempt <= .propagation_max_attempts and
    .routes_mutated == false and
    .crons_mutated == false and
    .durable_object_lifecycle_mutated == false and
    (.propagation_attempts_ndjson | contains("\"root_healthy\":true")) and
    (.wrangler_version_upload_ndjson | contains("\"type\":\"version-upload\"")) and
    (.wrangler_version_deploy_ndjson | contains("\"type\":\"version-deploy\""))
  ' "${evidence}" >/dev/null

restore_required=false
trap - EXIT INT TERM
