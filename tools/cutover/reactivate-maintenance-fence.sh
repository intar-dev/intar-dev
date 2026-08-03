#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 8 ]; then
  echo "usage: reactivate-maintenance-fence.sh <database-name> <database-id> <previous-version-id> <maintenance-version-id> <apply-run-id> <marker-sha256> <phase> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly previous_version_id="$3"
readonly maintenance_version_id="$4"
readonly apply_run_id="$5"
readonly expected_marker_sha256="$6"
readonly phase="$7"
readonly evidence="$8"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-clean-d1-pre-switch-reactivate-${GITHUB_RUN_ID:-local}-${phase}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly previous_version="${runtime_root}/previous-version.json"
readonly maintenance_version="${runtime_root}/maintenance-version.json"
readonly deploy_output="${runtime_root}/wrangler-version-deploy.ndjson"
readonly deploy_result="${runtime_root}/wrangler-version-deploy.json"
readonly mutation_receipt="${runtime_root}/mutation-receipt.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly propagation_log="${runtime_root}/public-propagation.ndjson"
readonly propagation_max_attempts=12
readonly propagation_interval_seconds=2
readonly propagation_request_timeout_seconds=5

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${previous_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${maintenance_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
test "${previous_version_id}" != "${maintenance_version_id}"
[[ "${apply_run_id}" =~ ^[1-9][0-9]*$ ]]
[[ "${expected_marker_sha256}" =~ ^[0-9a-f]{64}$ ]]
[[ "${phase}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test "${GITHUB_REPOSITORY:-}" = "intar-dev/intar-dev"
test "${GITHUB_REF:-}" = "refs/heads/main"
test "${GITHUB_RUN_ATTEMPT:-}" = 1
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"
: > "${deploy_output}"
: > "${propagation_log}"

bunx wrangler deployments status --name intar-dev --json > "${before_deployment}"
before_deployment_id="$(jq -er '.id' "${before_deployment}")"
before_version_id="$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "${before_deployment}")"
case "${before_version_id}" in
  "${previous_version_id}"|"${maintenance_version_id}") ;;
  *) echo "active version is not a resumable cutover version" >&2; exit 1 ;;
esac
bunx wrangler versions view "${before_version_id}" \
  --name intar-dev --json > "${before_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
  "${before_deployment}" "${before_version}" "${database_id}" \
  "${before_version_id}" >/dev/null

bunx wrangler versions view "${previous_version_id}" \
  --name intar-dev --json > "${previous_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" version-binding \
  "${previous_version}" "${database_id}" "${previous_version_id}" >/dev/null
bunx wrangler versions view "${maintenance_version_id}" \
  --name intar-dev --json > "${maintenance_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" version-binding \
  "${maintenance_version}" "${database_id}" "${maintenance_version_id}" >/dev/null
jq -e --arg tag "clean-d1-fence-${apply_run_id}" \
  '.annotations["workers/tag"] == $tag' "${maintenance_version}" >/dev/null

reactivated=false
must_deploy=false
if [ "${before_version_id}" = "${previous_version_id}" ] || [ "${phase}" = recovery ]; then
  must_deploy=true
fi
if [ "${must_deploy}" = true ]; then
  rm -f "${deploy_output}"
  WRANGLER_OUTPUT_FILE_PATH="${deploy_output}" \
    bunx wrangler versions deploy "${maintenance_version_id}@100%" \
      --name intar-dev \
      --message "Reactivate exact maintenance fence after website strict drain; apply run ${apply_run_id}" \
      --yes
  jq -n \
    --arg source_sha "${GITHUB_SHA}" \
    --arg apply_run_id "${apply_run_id}" \
    --arg phase "${phase}" \
    --arg database_id "${database_id}" \
    --arg previous_version_id "${previous_version_id}" \
    --arg maintenance_version_id "${maintenance_version_id}" \
    --arg before_deployment_id "${before_deployment_id}" \
    --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      {
        schema_version: 1,
        operation: "pre-switch-maintenance-reactivation-receipt",
        source_sha: $source_sha,
        apply_run_id: $apply_run_id,
        phase: $phase,
        database_id: $database_id,
        previous_version_id: $previous_version_id,
        maintenance_version_id: $maintenance_version_id,
        before_deployment_id: $before_deployment_id,
        maintenance_deployment_id: null,
        exact_maintenance_version_deployed: true,
        active_traffic_percentage: 100,
        database_mutated: false,
        routes_mutated: false,
        crons_mutated: false,
        durable_object_lifecycle_mutated: false,
        observed_at: $observed_at
      }
    ' > "${mutation_receipt}"
  bun "${repository_root}/tools/cutover/wrangler-output.ts" version-deploy \
    "${deploy_output}" intar-dev > "${deploy_result}"
  maintenance_deployment_id="$(jq -er '.deploymentId' "${deploy_result}")"
  reactivated=true
else
  maintenance_deployment_id="${before_deployment_id}"
fi

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg apply_run_id "${apply_run_id}" \
  --arg phase "${phase}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" \
  --arg before_deployment_id "${before_deployment_id}" \
  --arg maintenance_deployment_id "${maintenance_deployment_id}" \
  --argjson reactivated "${reactivated}" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      schema_version: 1,
      operation: "pre-switch-maintenance-reactivation-receipt",
      source_sha: $source_sha,
      apply_run_id: $apply_run_id,
      phase: $phase,
      database_id: $database_id,
      previous_version_id: $previous_version_id,
      maintenance_version_id: $maintenance_version_id,
      before_deployment_id: $before_deployment_id,
      maintenance_deployment_id: $maintenance_deployment_id,
      exact_maintenance_version_deployed: $reactivated,
      active_traffic_percentage: 100,
      database_mutated: false,
      routes_mutated: false,
      crons_mutated: false,
      durable_object_lifecycle_mutated: false,
      observed_at: $observed_at
    }
  ' > "${mutation_receipt}.complete"
mv "${mutation_receipt}.complete" "${mutation_receipt}"

bunx wrangler deployments status --name intar-dev --json > "${after_deployment}"
test "$(jq -er '.id' "${after_deployment}")" = "${maintenance_deployment_id}"
bunx wrangler versions view "${maintenance_version_id}" \
  --name intar-dev --json > "${after_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
  "${after_deployment}" "${after_version}" "${database_id}" \
  "${maintenance_version_id}" >/dev/null

propagation_attempts=0
marker_probe_attempt=""
root_probe_attempt=""
final_marker_status=000
final_root_status=000
propagation_proven=false
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  propagation_attempts="${attempt}"
  attempt_marker="${runtime_root}/marker-${attempt}.json"
  attempt_marker_headers="${runtime_root}/marker-${attempt}-headers.txt"
  attempt_root_headers="${runtime_root}/root-${attempt}-headers.txt"
  final_marker_status="$({ curl --silent --show-error \
    --connect-timeout 2 \
    --max-time "${propagation_request_timeout_seconds}" \
    --header 'Cache-Control: no-cache' \
    --dump-header "${attempt_marker_headers}" \
    --output "${attempt_marker}" \
    --write-out '%{http_code}' \
    https://intar.dev/.well-known/intar-clean-d1-cutover-fence; } || true)"
  [[ "${final_marker_status}" =~ ^[0-9]{3}$ ]] || final_marker_status=000
  marker_proven=false
  if [ "${final_marker_status}" = 200 ] && \
    [ "$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${attempt_marker_headers}" 2>/dev/null || true)" = 1 ] && \
    [ "$(grep -Eic '^cache-control:[[:space:]]*private,[[:space:]]*no-store[[:space:]]*$' "${attempt_marker_headers}" 2>/dev/null || true)" = 1 ] && \
    jq -e \
      --arg source_sha "${GITHUB_SHA}" \
      --arg apply_run_id "${apply_run_id}" \
      --arg database_id "${database_id}" \
      --arg previous_version_id "${previous_version_id}" '
        .schemaVersion == 1 and
        .state == "active" and
        .sourceSha == $source_sha and
        .runId == $apply_run_id and
        .runAttempt == 1 and
        .databaseId == $database_id and
        .previousVersionId == $previous_version_id
      ' "${attempt_marker}" >/dev/null 2>&1 && \
    [ "$(sha256sum "${attempt_marker}" | cut -d ' ' -f 1)" = "${expected_marker_sha256}" ]; then
    marker_proven=true
    test -n "${marker_probe_attempt}" || marker_probe_attempt="${attempt}"
  fi

  final_root_status="$({ curl --silent --show-error \
    --connect-timeout 2 \
    --max-time "${propagation_request_timeout_seconds}" \
    --header 'Cache-Control: no-cache' \
    --dump-header "${attempt_root_headers}" \
    --output /dev/null \
    --write-out '%{http_code}' \
    https://intar.dev/; } || true)"
  [[ "${final_root_status}" =~ ^[0-9]{3}$ ]] || final_root_status=000
  root_proven=false
  if [ "${final_root_status}" = 503 ] && \
    [ "$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${attempt_root_headers}" 2>/dev/null || true)" = 1 ] && \
    [ "$(grep -Eic '^cache-control:[[:space:]]*private,[[:space:]]*no-store[[:space:]]*$' "${attempt_root_headers}" 2>/dev/null || true)" = 1 ]; then
    root_proven=true
    test -n "${root_probe_attempt}" || root_probe_attempt="${attempt}"
  fi

  jq -cn \
    --argjson attempt "${attempt}" \
    --arg marker_http_status "${final_marker_status}" \
    --argjson marker_proven "${marker_proven}" \
    --arg root_http_status "${final_root_status}" \
    --argjson root_proven "${root_proven}" \
    '{attempt: $attempt, marker_http_status: $marker_http_status, marker_proven: $marker_proven, root_http_status: $root_http_status, root_proven: $root_proven}' \
    >> "${propagation_log}"
  if [ "${marker_proven}" = true ] && [ "${root_proven}" = true ]; then
    propagation_proven=true
    break
  fi
  if [ "${attempt}" -lt "${propagation_max_attempts}" ]; then
    sleep "${propagation_interval_seconds}"
  fi
done
test "${propagation_proven}" = true

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg apply_run_id "${apply_run_id}" \
  --arg phase "${phase}" \
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" \
  --arg before_deployment_id "${before_deployment_id}" \
  --arg before_version_id "${before_version_id}" \
  --arg maintenance_deployment_id "${maintenance_deployment_id}" \
  --argjson reactivated "${reactivated}" \
  --arg expected_marker_sha256 "${expected_marker_sha256}" \
  --argjson propagation_attempts "${propagation_attempts}" \
  --arg marker_probe_attempt "${marker_probe_attempt}" \
  --arg root_probe_attempt "${root_probe_attempt}" \
  --arg final_marker_status "${final_marker_status}" \
  --arg final_root_status "${final_root_status}" \
  --rawfile wrangler_version_deploy_ndjson "${deploy_output}" \
  --rawfile propagation_attempts_ndjson "${propagation_log}" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      schema_version: 1,
      operation: "reactivate-maintenance-fence",
      source_sha: $source_sha,
      apply_run_id: $apply_run_id,
      phase: $phase,
      database_name: $database_name,
      database_id: $database_id,
      previous_version_id: $previous_version_id,
      maintenance_version_id: $maintenance_version_id,
      before_deployment_id: $before_deployment_id,
      before_active_version_id: $before_version_id,
      maintenance_deployment_id: $maintenance_deployment_id,
      reactivated: $reactivated,
      expected_marker_sha256: $expected_marker_sha256,
      active_traffic_percentage: 100,
      wrangler_version_deploy_ndjson: $wrangler_version_deploy_ndjson,
      propagation: {
        max_attempts: 12,
        interval_seconds: 2,
        request_timeout_seconds: 5,
        attempts: $propagation_attempts,
        marker_probe_attempt: ($marker_probe_attempt | tonumber),
        root_probe_attempt: ($root_probe_attempt | tonumber),
        final_marker_http_status: $final_marker_status,
        final_root_http_status: $final_root_status,
        proven: true,
        attempts_ndjson: $propagation_attempts_ndjson
      },
      before_active_binding_proven: true,
      previous_version_binding_proven: true,
      maintenance_version_binding_proven: true,
      after_active_binding_proven: true,
      database_mutated: false,
      routes_mutated: false,
      crons_mutated: false,
      durable_object_lifecycle_mutated: false,
      observed_at: $observed_at
    }
  ' > "${evidence}"

jq -e \
  --arg source_sha "${GITHUB_SHA}" \
  --arg apply_run_id "${apply_run_id}" \
  --arg phase "${phase}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" \
  --arg marker_sha256 "${expected_marker_sha256}" '
    .schema_version == 1 and
    .operation == "reactivate-maintenance-fence" and
    .source_sha == $source_sha and
    .apply_run_id == $apply_run_id and
    .phase == $phase and
    .database_id == $database_id and
    .previous_version_id == $previous_version_id and
    .maintenance_version_id == $maintenance_version_id and
    .expected_marker_sha256 == $marker_sha256 and
    .active_traffic_percentage == 100 and
    .propagation.attempts >= 1 and
    .propagation.attempts <= .propagation.max_attempts and
    .propagation.marker_probe_attempt >= 1 and
    .propagation.root_probe_attempt >= 1 and
    .propagation.final_marker_http_status == "200" and
    .propagation.final_root_http_status == "503" and
    .propagation.proven == true and
    .before_active_binding_proven == true and
    .previous_version_binding_proven == true and
    .maintenance_version_binding_proven == true and
    .after_active_binding_proven == true and
    .database_mutated == false and
    .routes_mutated == false and
    .crons_mutated == false and
    .durable_object_lifecycle_mutated == false and
    (
      (.reactivated == false and .before_active_version_id == $maintenance_version_id and .before_deployment_id == .maintenance_deployment_id and .wrangler_version_deploy_ndjson == "") or
      (.reactivated == true and (.before_active_version_id == $previous_version_id or (.phase == "recovery" and .before_active_version_id == $maintenance_version_id)) and .before_deployment_id != .maintenance_deployment_id and (.wrangler_version_deploy_ndjson | contains("\"type\":\"version-deploy\"")))
    )
  ' "${evidence}" >/dev/null
