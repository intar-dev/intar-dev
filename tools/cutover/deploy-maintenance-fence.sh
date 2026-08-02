#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: deploy-maintenance-fence.sh <database-name> <database-id> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly evidence="$3"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-clean-d1-maintenance-${GITHUB_RUN_ID:-local}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly recorded_previous_version="${runtime_root}/recorded-previous-version.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly config="${runtime_root}/wrangler.jsonc"
readonly marker="${runtime_root}/marker.json"
readonly observed_marker="${runtime_root}/observed-marker.json"
readonly observed_headers="${runtime_root}/observed-headers.txt"
readonly existing_marker="${runtime_root}/existing-marker.json"
readonly existing_headers="${runtime_root}/existing-headers.txt"

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GITHUB_RUN_ID:-}"
test -n "${GITHUB_RUN_ATTEMPT:-}"
test "${GITHUB_RUN_ATTEMPT}" = 1
test -n "${GITHUB_SHA:-}"

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"
bunx wrangler deployments status --name intar-dev --json > "${before_deployment}"
previous_version_id="$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "${before_deployment}")"
[[ "${previous_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
bunx wrangler versions view "${previous_version_id}" \
  --name intar-dev --json > "${before_version}"
bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
  "${before_deployment}" "${before_version}" "${database_id}" \
  "${previous_version_id}" >/dev/null

reused=false
existing_status="$({ curl --silent --show-error \
  --header 'Cache-Control: no-cache' \
  --dump-header "${existing_headers}" \
  --output "${existing_marker}" \
  --write-out '%{http_code}' \
  https://intar.dev/.well-known/intar-clean-d1-cutover-fence; } || true)"
if [ "${existing_status}" = 200 ] && \
  grep -qi '^x-intar-cutover-fence: active' "${existing_headers}" && \
  jq -e \
    --arg source_sha "${GITHUB_SHA}" \
    --arg database_id "${database_id}" '
      .schemaVersion == 1 and
      .state == "active" and
      .sourceSha == $source_sha and
      .databaseId == $database_id and
      (.runId | test("^[1-9][0-9]*$")) and
      .runAttempt == 1 and
      (.previousVersionId | test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")) and
      (.nonce | test("^[0-9a-f-]{36}$"))
    ' "${existing_marker}" >/dev/null; then
  reused=true
  maintenance_version_id="${previous_version_id}"
  previous_version_id="$(jq -r '.previousVersionId' "${existing_marker}")"
  [[ "${previous_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
  test "${maintenance_version_id}" != "${previous_version_id}"
  if [ -n "${EXPECTED_PREVIOUS_WEB_VERSION_ID:-}" ]; then
    test "${previous_version_id}" = "${EXPECTED_PREVIOUS_WEB_VERSION_ID}"
  fi
  bunx wrangler versions view "${previous_version_id}" \
    --name intar-dev --json > "${recorded_previous_version}"
  bun "${repository_root}/tools/cutover/worker-version.ts" version-binding \
    "${recorded_previous_version}" "${database_id}" \
    "${previous_version_id}" >/dev/null
  cp "${existing_marker}" "${marker}"
  cp "${before_deployment}" "${after_deployment}"
  cp "${before_version}" "${after_version}"
else
  if [ -n "${EXPECTED_PREVIOUS_WEB_VERSION_ID:-}" ]; then
    test "${previous_version_id}" = "${EXPECTED_PREVIOUS_WEB_VERSION_ID}"
  fi
  marker_nonce="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
  jq -cn \
    --arg schema_version "1" \
    --arg state "active" \
    --arg source_sha "${GITHUB_SHA}" \
    --arg run_id "${GITHUB_RUN_ID}" \
    --arg run_attempt "${GITHUB_RUN_ATTEMPT}" \
    --arg database_id "${database_id}" \
    --arg previous_version_id "${previous_version_id}" \
    --arg nonce "${marker_nonce}" \
    '{schemaVersion: ($schema_version | tonumber), state: $state, sourceSha: $source_sha, runId: $run_id, runAttempt: ($run_attempt | tonumber), databaseId: $database_id, previousVersionId: $previous_version_id, nonce: $nonce}' \
    > "${marker}"
  marker_json="$(<"${marker}")"

  jq -n \
    --arg main "${repository_root}/tools/cutover/maintenance-worker/src/index.ts" \
    --arg marker "${marker_json}" \
    --arg database_name "${database_name}" \
    --arg database_id "${database_id}" '
      {
        name: "intar-dev",
        main: $main,
        compatibility_date: "2026-07-09",
        workers_dev: false,
        preview_urls: false,
        vars: {CUTOVER_FENCE_MARKER: $marker},
        routes: [{pattern: "intar.dev", custom_domain: true}],
        triggers: {crons: ["* * * * *"]},
        d1_databases: [{binding: "DB", database_name: $database_name, database_id: $database_id}]
      }
    ' > "${config}"

  bunx wrangler deploy \
    --config "${config}" \
    --message "Clean D1 maintenance fence for run ${GITHUB_RUN_ID}"

  bunx wrangler deployments status --name intar-dev --json > "${after_deployment}"
  maintenance_version_id="$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "${after_deployment}")"
  [[ "${maintenance_version_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
  test "${maintenance_version_id}" != "${previous_version_id}"
  bunx wrangler versions view "${maintenance_version_id}" \
    --name intar-dev --json > "${after_version}"
  bun "${repository_root}/tools/cutover/worker-version.ts" active-binding \
    "${after_deployment}" "${after_version}" "${database_id}" \
    "${maintenance_version_id}" >/dev/null
fi

curl --fail-with-body --silent --show-error \
  --header 'Cache-Control: no-cache' \
  --dump-header "${observed_headers}" \
  --output "${observed_marker}" \
  https://intar.dev/.well-known/intar-clean-d1-cutover-fence
test "$(<"${marker}")" = "$(<"${observed_marker}")"
grep -qi '^x-intar-cutover-fence: active' "${observed_headers}"
grep -qi '^cache-control: private, no-store' "${observed_headers}"
status="$({ curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request POST https://intar.dev/api/workshops; } || true)"
test "${status}" = 503

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --argjson run_attempt "${GITHUB_RUN_ATTEMPT}" \
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg previous_version_id "${previous_version_id}" \
  --arg maintenance_version_id "${maintenance_version_id}" \
  --argjson reused "${reused}" \
  --arg marker_sha256 "$(sha256sum "${observed_marker}" | cut -d ' ' -f 1)" '
    {
      schema_version: 1,
      operation: "activate-maintenance-fence",
      state: "active",
      source_sha: $source_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      database_name: $database_name,
      database_id: $database_id,
      previous_version_id: $previous_version_id,
      maintenance_version_id: $maintenance_version_id,
      reused: $reused,
      previous_version_binding_proven: true,
      maintenance_version_binding_proven: true,
      marker_sha256: $marker_sha256,
      marker_endpoint: "https://intar.dev/.well-known/intar-clean-d1-cutover-fence",
      all_other_http_status: 503
    }
  ' > "${evidence}"

jq -e \
  --arg database_id "${database_id}" \
  '.state == "active" and
   .database_id == $database_id and
   .maintenance_version_id != .previous_version_id and
   .previous_version_binding_proven == true and
   .maintenance_version_binding_proven == true and
   .all_other_http_status == 503' \
  "${evidence}" >/dev/null
