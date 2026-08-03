#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: restore-successful-maintenance-fence.sh <database-name> <database-id> <previous-version-id> <maintenance-version-id> <apply-run-id> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly previous_version_id="$3"
readonly maintenance_version_id="$4"
readonly apply_run_id="$5"
readonly evidence="$6"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-clean-d1-pre-switch-restore-${GITHUB_RUN_ID:-local}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly previous_version="${runtime_root}/previous-version.json"
readonly maintenance_version="${runtime_root}/maintenance-version.json"
readonly marker="${runtime_root}/marker.json"
readonly marker_headers="${runtime_root}/marker-headers.txt"
readonly origin_run="${runtime_root}/origin-run.json"
readonly origin_workflow="${runtime_root}/origin-workflow.json"
readonly deploy_output="${runtime_root}/wrangler-version-deploy.ndjson"
readonly deploy_result="${runtime_root}/wrangler-version-deploy.json"
readonly mutation_receipt="${runtime_root}/mutation-receipt.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly propagation_log="${runtime_root}/public-propagation.ndjson"
readonly propagation_max_attempts=12
readonly propagation_interval_seconds=5
readonly propagation_request_timeout_seconds=5

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${previous_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${maintenance_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
test "${previous_version_id}" != "${maintenance_version_id}"
[[ "${apply_run_id}" =~ ^[1-9][0-9]*$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GH_TOKEN:-}"
test "${GITHUB_REPOSITORY:-}" = "intar-dev/intar-dev"
test "${GITHUB_REF:-}" = "refs/heads/main"
test "${GITHUB_RUN_ATTEMPT:-}" = 1
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"
: > "${propagation_log}"
: > "${deploy_output}"

gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${apply_run_id}" > "${origin_run}"
origin_workflow_id="$(jq -er '.workflow_id' "${origin_run}")"
gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/${origin_workflow_id}" \
  > "${origin_workflow}"
jq -e \
  --argjson run_id "${apply_run_id}" \
  --arg source_sha "${GITHUB_SHA}" '
    .id == $run_id and
    .repository.full_name == "intar-dev/intar-dev" and
    .event == "workflow_dispatch" and
    .head_branch == "main" and
    .head_sha == $source_sha and
    .run_attempt == 1 and
    .status == "completed" and
    .conclusion == "success"
  ' "${origin_run}" >/dev/null
jq -e '
  .path == ".github/workflows/clean-d1-cutover.yml" and
  .state == "active"
' "${origin_workflow}" >/dev/null

bunx wrangler deployments status --name intar-dev --json > "${before_deployment}"
before_deployment_id="$(jq -er '.id' "${before_deployment}")"
before_version_id="$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "${before_deployment}")"
case "${before_version_id}" in
  "${maintenance_version_id}"|"${previous_version_id}") ;;
  *) echo "active version is neither the exact maintenance nor previous version" >&2; exit 1 ;;
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

restored=false
marker_sha256=""
if [ "${before_version_id}" = "${maintenance_version_id}" ]; then
  marker_status="$(curl --fail-with-body --silent --show-error \
    --connect-timeout 2 \
    --max-time "${propagation_request_timeout_seconds}" \
    --header 'Cache-Control: no-cache' \
    --dump-header "${marker_headers}" \
    --output "${marker}" \
    --write-out '%{http_code}' \
    https://intar.dev/.well-known/intar-clean-d1-cutover-fence)"
  test "${marker_status}" = 200
  test "$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${marker_headers}")" = 1
  test "$(grep -Eic '^cache-control:[[:space:]]*private,[[:space:]]*no-store[[:space:]]*$' "${marker_headers}")" = 1
  jq -e \
    --arg source_sha "${GITHUB_SHA}" \
    --arg database_id "${database_id}" \
    --arg previous_version_id "${previous_version_id}" \
    --arg apply_run_id "${apply_run_id}" '
      .schemaVersion == 1 and
      .state == "active" and
      .sourceSha == $source_sha and
      .databaseId == $database_id and
      .previousVersionId == $previous_version_id and
      .runId == $apply_run_id and
      .runAttempt == 1 and
      (.nonce | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"))
    ' "${marker}" >/dev/null
  marker_sha256="$(sha256sum "${marker}" | cut -d ' ' -f 1)"

  rm -f "${deploy_output}"
  WRANGLER_OUTPUT_FILE_PATH="${deploy_output}" \
    bunx wrangler versions deploy "${previous_version_id}@100%" \
      --name intar-dev \
      --message "Restore exact pre-fence version before website strict drain; apply run ${apply_run_id}" \
      --yes
  jq -n \
    --arg source_sha "${GITHUB_SHA}" \
    --arg apply_run_id "${apply_run_id}" \
    --arg database_id "${database_id}" \
    --arg previous_version_id "${previous_version_id}" \
    --arg maintenance_version_id "${maintenance_version_id}" \
    --arg before_deployment_id "${before_deployment_id}" \
    --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      {
        schema_version: 1,
        operation: "pre-switch-exact-version-mutation-receipt",
        source_sha: $source_sha,
        apply_run_id: $apply_run_id,
        database_id: $database_id,
        previous_version_id: $previous_version_id,
        maintenance_version_id: $maintenance_version_id,
        before_deployment_id: $before_deployment_id,
        restore_deployment_id: null,
        exact_previous_version_deployed: true,
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
  restore_deployment_id="$(jq -er '.deploymentId' "${deploy_result}")"
  restored=true
else
  restore_deployment_id="${before_deployment_id}"
fi

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg apply_run_id "${apply_run_id}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" \
  --arg before_deployment_id "${before_deployment_id}" \
  --arg restore_deployment_id "${restore_deployment_id}" \
  --argjson restored "${restored}" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      schema_version: 1,
      operation: "pre-switch-exact-version-mutation-receipt",
      source_sha: $source_sha,
      apply_run_id: $apply_run_id,
      database_id: $database_id,
      previous_version_id: $previous_version_id,
      maintenance_version_id: $maintenance_version_id,
      before_deployment_id: $before_deployment_id,
      restore_deployment_id: $restore_deployment_id,
      exact_previous_version_deployed: $restored,
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
test "$(jq -er '.id' "${after_deployment}")" = "${restore_deployment_id}"
bunx wrangler versions view "${previous_version_id}" \
  --name intar-dev --json > "${after_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
  "${after_deployment}" "${after_version}" "${database_id}" \
  "${previous_version_id}" >/dev/null

propagation_attempts=0
marker_clear_attempt=""
root_healthy_attempt=""
final_marker_status=000
final_root_status=000
propagation_proven=false
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  propagation_attempts="${attempt}"
  attempt_marker_headers="${runtime_root}/after-marker-${attempt}-headers.txt"
  attempt_root_headers="${runtime_root}/after-root-${attempt}-headers.txt"
  final_marker_status="$({ curl --silent --show-error \
    --connect-timeout 2 \
    --max-time "${propagation_request_timeout_seconds}" \
    --header 'Cache-Control: no-cache' \
    --dump-header "${attempt_marker_headers}" \
    --output /dev/null \
    --write-out '%{http_code}' \
    https://intar.dev/.well-known/intar-clean-d1-cutover-fence; } || true)"
  [[ "${final_marker_status}" =~ ^[0-9]{3}$ ]] || final_marker_status=000
  marker_fence_headers="$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${attempt_marker_headers}" 2>/dev/null || true)"
  final_root_status="$({ curl --silent --show-error \
    --connect-timeout 2 \
    --max-time "${propagation_request_timeout_seconds}" \
    --header 'Cache-Control: no-cache' \
    --dump-header "${attempt_root_headers}" \
    --output /dev/null \
    --write-out '%{http_code}' \
    https://intar.dev/; } || true)"
  [[ "${final_root_status}" =~ ^[0-9]{3}$ ]] || final_root_status=000
  root_fence_headers="$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${attempt_root_headers}" 2>/dev/null || true)"
  marker_clear=false
  root_healthy=false
  if [[ "${final_marker_status}" =~ ^[234][0-9]{2}$ ]] && [ "${marker_fence_headers}" = 0 ]; then
    marker_clear=true
    test -n "${marker_clear_attempt}" || marker_clear_attempt="${attempt}"
  fi
  if [ "${final_root_status}" = 200 ] && [ "${root_fence_headers}" = 0 ]; then
    root_healthy=true
    test -n "${root_healthy_attempt}" || root_healthy_attempt="${attempt}"
  fi
  jq -cn \
    --argjson attempt "${attempt}" \
    --arg marker_http_status "${final_marker_status}" \
    --argjson marker_fence_header_count "${marker_fence_headers}" \
    --argjson marker_clear "${marker_clear}" \
    --arg root_http_status "${final_root_status}" \
    --argjson root_fence_header_count "${root_fence_headers}" \
    --argjson root_healthy "${root_healthy}" \
    '{attempt: $attempt, marker_http_status: $marker_http_status, marker_fence_header_count: $marker_fence_header_count, marker_clear: $marker_clear, root_http_status: $root_http_status, root_fence_header_count: $root_fence_header_count, root_healthy: $root_healthy}' \
    >> "${propagation_log}"
  if [ "${marker_clear}" = true ] && [ "${root_healthy}" = true ]; then
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
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" \
  --arg before_deployment_id "${before_deployment_id}" \
  --arg before_version_id "${before_version_id}" \
  --arg restore_deployment_id "${restore_deployment_id}" \
  --argjson restored "${restored}" \
  --arg marker_sha256 "${marker_sha256}" \
  --argjson propagation_attempts "${propagation_attempts}" \
  --arg marker_clear_attempt "${marker_clear_attempt}" \
  --arg root_healthy_attempt "${root_healthy_attempt}" \
  --arg final_marker_status "${final_marker_status}" \
  --arg final_root_status "${final_root_status}" \
  --rawfile wrangler_version_deploy_ndjson "${deploy_output}" \
  --rawfile propagation_attempts_ndjson "${propagation_log}" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      schema_version: 1,
      operation: "restore-successful-maintenance-fence",
      source_sha: $source_sha,
      apply_run_id: $apply_run_id,
      database_name: $database_name,
      database_id: $database_id,
      previous_version_id: $previous_version_id,
      maintenance_version_id: $maintenance_version_id,
      before_deployment_id: $before_deployment_id,
      before_active_version_id: $before_version_id,
      restore_deployment_id: $restore_deployment_id,
      restored: $restored,
      marker_sha256: (if $marker_sha256 == "" then null else $marker_sha256 end),
      after_active_version_id: $previous_version_id,
      active_traffic_percentage: 100,
      wrangler_version_deploy_ndjson: $wrangler_version_deploy_ndjson,
      restore_propagation: {
        max_attempts: 12,
        interval_seconds: 5,
        request_timeout_seconds: 5,
        attempts: $propagation_attempts,
        marker_clear_attempt: ($marker_clear_attempt | tonumber),
        root_healthy_attempt: ($root_healthy_attempt | tonumber),
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
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" '
    .schema_version == 1 and
    .operation == "restore-successful-maintenance-fence" and
    .source_sha == $source_sha and
    .apply_run_id == $apply_run_id and
    .database_id == $database_id and
    .previous_version_id == $previous_version_id and
    .maintenance_version_id == $maintenance_version_id and
    (.before_deployment_id | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")) and
    (.restore_deployment_id | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")) and
    .after_active_version_id == $previous_version_id and
    .active_traffic_percentage == 100 and
    .restore_propagation.attempts >= 1 and
    .restore_propagation.attempts <= .restore_propagation.max_attempts and
    .restore_propagation.marker_clear_attempt >= 1 and
    .restore_propagation.root_healthy_attempt >= 1 and
    .restore_propagation.final_root_http_status == "200" and
    .restore_propagation.proven == true and
    .before_active_binding_proven == true and
    .previous_version_binding_proven == true and
    .maintenance_version_binding_proven == true and
    .after_active_binding_proven == true and
    .database_mutated == false and
    .routes_mutated == false and
    .crons_mutated == false and
    .durable_object_lifecycle_mutated == false and
    (
      (.restored == false and .before_active_version_id == $previous_version_id and .before_deployment_id == .restore_deployment_id and .marker_sha256 == null and .wrangler_version_deploy_ndjson == "") or
      (.restored == true and .before_active_version_id == $maintenance_version_id and .before_deployment_id != .restore_deployment_id and (.marker_sha256 | test("^[0-9a-f]{64}$")) and (.wrangler_version_deploy_ndjson | contains("\"type\":\"version-deploy\"")))
    )
  ' "${evidence}" >/dev/null
