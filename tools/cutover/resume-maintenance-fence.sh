#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: resume-maintenance-fence.sh <database-name> <database-id> <previous-version-id> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly previous_version_id="$3"
readonly evidence="$4"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-clean-d1-resume-${GITHUB_RUN_ID:-local}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly previous_version="${runtime_root}/previous-version.json"
readonly marker="${runtime_root}/marker.json"
readonly marker_headers="${runtime_root}/marker-headers.txt"
readonly origin_run="${runtime_root}/origin-run.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly deploy_output="${runtime_root}/wrangler-version-deploy.ndjson"
readonly deploy_result="${runtime_root}/wrangler-version-deploy.json"
readonly after_marker="${runtime_root}/after-marker.json"
readonly after_marker_headers="${runtime_root}/after-marker-headers.txt"

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${previous_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GH_TOKEN:-}"
test "${GITHUB_REPOSITORY:-}" = "intar-dev/intar-dev"
test "${GITHUB_REF:-}" = "refs/heads/main"
test -n "${GITHUB_RUN_ID:-}"
[[ "${GITHUB_RUN_ID}" =~ ^[1-9][0-9]*$ ]]
test "${GITHUB_RUN_ATTEMPT:-}" = 1
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"

bunx wrangler deployments status --name intar-dev --json > "${before_deployment}"
before_deployment_id="$(jq -er '.id | select(type == "string" and test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"))' "${before_deployment}")"
before_version_id="$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "${before_deployment}")"
[[ "${before_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
bunx wrangler versions view "${before_version_id}" \
  --name intar-dev --json > "${before_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
  "${before_deployment}" "${before_version}" "${database_id}" \
  "${before_version_id}" >/dev/null

bunx wrangler versions view "${previous_version_id}" \
  --name intar-dev --json > "${previous_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" version-binding \
  "${previous_version}" "${database_id}" "${previous_version_id}" >/dev/null

marker_status="$(curl --silent --show-error \
  --header 'Cache-Control: no-cache' \
  --dump-header "${marker_headers}" \
  --output "${marker}" \
  --write-out '%{http_code}' \
  https://intar.dev/.well-known/intar-clean-d1-cutover-fence)"
[[ "${marker_status}" =~ ^[0-9]{3}$ ]]
fence_header_count="$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${marker_headers}" || true)"
[[ "${fence_header_count}" =~ ^[0-9]+$ ]]
test "${fence_header_count}" -le 1

restored=false
fence_detected=false
marker_sha256=""
origin_run_id=""
origin_run_conclusion=""
active_fence_tag=""
active_fence_tag_proven=false
if [ "${fence_header_count}" = 1 ]; then
  fence_detected=true
  test "${marker_status}" = 200
  test "$(grep -Eic '^cache-control:[[:space:]]*private,[[:space:]]*no-store[[:space:]]*$' "${marker_headers}" || true)" = 1
  jq -e \
    --arg source_sha "${GITHUB_SHA}" \
    --arg database_id "${database_id}" \
    --arg previous_version_id "${previous_version_id}" \
    --arg current_run_id "${GITHUB_RUN_ID}" '
      .schemaVersion == 1 and
      .state == "active" and
      .sourceSha == $source_sha and
      .databaseId == $database_id and
      .previousVersionId == $previous_version_id and
      (.runId | test("^[1-9][0-9]*$")) and
      .runId != $current_run_id and
      .runAttempt == 1 and
      (.nonce | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"))
    ' "${marker}" >/dev/null
  test "${before_version_id}" != "${previous_version_id}"

  origin_run_id="$(jq -r '.runId' "${marker}")"
  active_fence_tag="clean-d1-fence-${origin_run_id}"
  jq -e --arg tag "${active_fence_tag}" \
    '.annotations["workers/tag"] == $tag' "${before_version}" >/dev/null
  active_fence_tag_proven=true
  current_workflow_id="$(
    gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
      --jq '.workflow_id'
  )"
  [[ "${current_workflow_id}" =~ ^[1-9][0-9]*$ ]]
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${origin_run_id}" \
    > "${origin_run}"
  jq -e \
    --argjson origin_run_id "${origin_run_id}" \
    --argjson workflow_id "${current_workflow_id}" \
    --arg source_sha "${GITHUB_SHA}" '
      .id == $origin_run_id and
      .repository.full_name == "intar-dev/intar-dev" and
      .workflow_id == $workflow_id and
      .event == "workflow_dispatch" and
      .head_branch == "main" and
      .head_sha == $source_sha and
      .run_attempt == 1 and
      .status == "completed" and
      (.conclusion | IN("failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"))
    ' "${origin_run}" >/dev/null
  origin_run_conclusion="$(jq -r '.conclusion' "${origin_run}")"
  marker_sha256="$(sha256sum "${marker}" | cut -d ' ' -f 1)"

  test ! -e "${deploy_output}"
  WRANGLER_OUTPUT_FILE_PATH="${deploy_output}" \
    bunx wrangler versions deploy "${previous_version_id}@100%" \
      --name intar-dev \
      --message "Restore exact pre-fence version before resumed strict drain; origin run ${origin_run_id}" \
      --yes
  bun "${repository_root}/tools/cutover/wrangler-output.ts" version-deploy \
    "${deploy_output}" intar-dev > "${deploy_result}"
  restore_deployment_id="$(jq -er '.deploymentId' "${deploy_result}")"
  [[ "${restore_deployment_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
  restored=true

  bunx wrangler deployments status --name intar-dev --json > "${after_deployment}"
  observed_after_deployment_id="$(jq -er '.id' "${after_deployment}")"
  test "${observed_after_deployment_id}" = "${restore_deployment_id}"
  bunx wrangler versions view "${previous_version_id}" \
    --name intar-dev --json > "${after_version}"
  bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
    "${after_deployment}" "${after_version}" "${database_id}" \
    "${previous_version_id}" >/dev/null

  after_marker_status="$(curl --silent --show-error \
    --header 'Cache-Control: no-cache' \
    --dump-header "${after_marker_headers}" \
    --output "${after_marker}" \
    --write-out '%{http_code}' \
    https://intar.dev/.well-known/intar-clean-d1-cutover-fence)"
  [[ "${after_marker_status}" =~ ^[0-9]{3}$ ]]
  test "$(grep -Eic '^x-intar-cutover-fence:[[:space:]]*active[[:space:]]*$' "${after_marker_headers}" || true)" = 0
else
  test "${before_version_id}" = "${previous_version_id}"
  restore_deployment_id="${before_deployment_id}"
  cp "${before_deployment}" "${after_deployment}"
  cp "${before_version}" "${after_version}"
fi

if [ ! -e "${deploy_output}" ]; then
  : > "${deploy_output}"
fi

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --argjson run_attempt "${GITHUB_RUN_ATTEMPT}" \
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg before_deployment_id "${before_deployment_id}" \
  --arg before_version_id "${before_version_id}" \
  --arg restore_deployment_id "${restore_deployment_id}" \
  --argjson fence_detected "${fence_detected}" \
  --argjson restored "${restored}" \
  --arg marker_sha256 "${marker_sha256}" \
  --arg origin_run_id "${origin_run_id}" \
  --arg origin_run_conclusion "${origin_run_conclusion}" \
  --arg active_fence_tag "${active_fence_tag}" \
  --argjson active_fence_tag_proven "${active_fence_tag_proven}" \
  --rawfile wrangler_version_deploy_ndjson "${deploy_output}" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      schema_version: 1,
      operation: "resume-maintenance-fence",
      source_sha: $source_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      database_name: $database_name,
      database_id: $database_id,
      expected_previous_version_id: $previous_version_id,
      before_deployment_id: $before_deployment_id,
      before_active_version_id: $before_version_id,
      fence_detected: $fence_detected,
      restored: $restored,
      marker_sha256: (if $marker_sha256 == "" then null else $marker_sha256 end),
      origin_run_id: (if $origin_run_id == "" then null else $origin_run_id end),
      origin_run_conclusion: (if $origin_run_conclusion == "" then null else $origin_run_conclusion end),
      active_fence_tag: (if $active_fence_tag == "" then null else $active_fence_tag end),
      active_fence_tag_proven: $active_fence_tag_proven,
      restore_deployment_id: $restore_deployment_id,
      after_active_version_id: $previous_version_id,
      active_traffic_percentage: 100,
      wrangler_version_deploy_ndjson: $wrangler_version_deploy_ndjson,
      before_active_binding_proven: true,
      previous_version_binding_proven: true,
      after_active_binding_proven: true,
      database_mutated: false,
      routes_mutated: false,
      crons_mutated: false,
      observed_at: $observed_at
    }
  ' > "${evidence}"

jq -e \
  --arg source_sha "${GITHUB_SHA}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" '
    .schema_version == 1 and
    .operation == "resume-maintenance-fence" and
    .source_sha == $source_sha and
    .database_id == $database_id and
    .expected_previous_version_id == $previous_version_id and
    (.before_deployment_id | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")) and
    (.restore_deployment_id | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")) and
    .after_active_version_id == $previous_version_id and
    .active_traffic_percentage == 100 and
    .before_active_binding_proven == true and
    .previous_version_binding_proven == true and
    .after_active_binding_proven == true and
    .database_mutated == false and
    .routes_mutated == false and
    .crons_mutated == false and
    (
      (.restored == false and .fence_detected == false and .before_active_version_id == $previous_version_id and .before_deployment_id == .restore_deployment_id and .origin_run_id == null and .active_fence_tag == null and .active_fence_tag_proven == false and .wrangler_version_deploy_ndjson == "") or
      (.restored == true and .fence_detected == true and .before_active_version_id != $previous_version_id and .before_deployment_id != .restore_deployment_id and (.marker_sha256 | test("^[0-9a-f]{64}$")) and (.origin_run_id | test("^[1-9][0-9]*$")) and .active_fence_tag == ("clean-d1-fence-" + .origin_run_id) and .active_fence_tag_proven == true and (.wrangler_version_deploy_ndjson | contains("\"type\":\"version-deploy\"")))
    )
  ' "${evidence}" >/dev/null
