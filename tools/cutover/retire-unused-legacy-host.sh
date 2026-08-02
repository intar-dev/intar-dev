#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: retire-unused-legacy-host.sh <database-name> <database-id> <host-id> <host-name> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly host_id="$3"
readonly host_name="$4"
readonly evidence="$5"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-legacy-host-retirement-${GITHUB_RUN_ID:-local}"
readonly config="${runtime_root}/wrangler.jsonc"
readonly before="${runtime_root}/before.json"
readonly token_update="${runtime_root}/token-update.json"
readonly host_update="${runtime_root}/host-update.json"
readonly after="${runtime_root}/after.json"

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${host_id}" =~ ^[a-z0-9][a-z0-9-]{0,127}$ ]]
[[ "${host_name}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"
jq -n \
  --arg name "${database_name}" \
  --arg id "${database_id}" \
  '{name: "intar-clean-d1-legacy-host-retirement", compatibility_date: "2026-07-09", d1_databases: [{binding: "LEGACY_DB", database_name: $name, database_id: $id}]}' \
  > "${config}"

readonly state_sql="SELECT
  (SELECT count(*) FROM agent_hosts WHERE id = '${host_id}' AND name = '${host_name}') AS matching_hosts,
  (SELECT count(*) FROM agent_hosts WHERE id = '${host_id}' AND role = 'builder' AND organization_id IS NULL) AS personal_builder_hosts,
  (SELECT count(*) FROM agent_hosts WHERE id = '${host_id}' AND disabled = 1) AS disabled_hosts,
  (SELECT count(*) FROM agent_hosts WHERE id = '${host_id}' AND connected = 0 AND connected_at IS NULL AND last_heartbeat_at IS NULL AND last_inventory_at IS NULL) AS never_connected_hosts,
  (SELECT count(*) FROM host_actual_state WHERE host_id = '${host_id}') AS actual_state_rows,
  (SELECT count(*) FROM host_desired_state WHERE host_id = '${host_id}') AS desired_state_rows,
  (SELECT count(*) FROM scenario_runs WHERE host_id = '${host_id}') AS scenario_run_rows,
  (SELECT count(*) FROM runtime_executions WHERE host_id = '${host_id}') AS runtime_execution_rows,
  (SELECT count(*) FROM runtime_vm_actual_state WHERE host_id = '${host_id}') AS runtime_vm_actual_state_rows,
  (SELECT count(*) FROM image_builds WHERE host_id = '${host_id}') AS image_build_rows,
  (SELECT count(*) FROM host_resource_reservations WHERE host_id = '${host_id}' AND released_at IS NULL) AS active_resource_reservations,
  (SELECT count(*) FROM host_cpu_reservations WHERE host_id = '${host_id}') AS active_cpu_reservations,
  (SELECT count(*) FROM workshop_publications WHERE builder_host_id = '${host_id}' AND status IN ('queued', 'building')) AS active_workshop_publications,
  (SELECT count(*) FROM workshop_publications WHERE builder_host_id = '${host_id}') AS workshop_publication_history,
  (SELECT count(*) FROM agent_bootstrap_tokens WHERE host_id = '${host_id}' AND revoked_at IS NULL) AS active_bootstrap_tokens;"

bunx wrangler d1 execute LEGACY_DB \
  --remote \
  --config "${config}" \
  --command "${state_sql}" \
  --json > "${before}"
jq -e '
  length == 1 and
  .[0].success == true and
  (.[0].results | length) == 1 and
  .[0].results[0].matching_hosts == 1 and
  .[0].results[0].personal_builder_hosts == 1 and
  (.[0].results[0].disabled_hosts | IN(0, 1)) and
  .[0].results[0].never_connected_hosts == 1 and
  .[0].results[0].actual_state_rows == 0 and
  .[0].results[0].desired_state_rows == 0 and
  .[0].results[0].scenario_run_rows == 0 and
  .[0].results[0].runtime_execution_rows == 0 and
  .[0].results[0].runtime_vm_actual_state_rows == 0 and
  .[0].results[0].image_build_rows == 0 and
  .[0].results[0].active_resource_reservations == 0 and
  .[0].results[0].active_cpu_reservations == 0 and
  .[0].results[0].active_workshop_publications == 0
' "${before}" >/dev/null

readonly now_ms="$(date -u +%s%3N)"
bunx wrangler d1 execute LEGACY_DB \
  --remote \
  --config "${config}" \
  --command "UPDATE agent_bootstrap_tokens SET revoked_at = coalesce(revoked_at, ${now_ms}) WHERE host_id = '${host_id}' AND revoked_at IS NULL RETURNING id" \
  --json > "${token_update}"
jq -e 'length == 1 and .[0].success == true' "${token_update}" >/dev/null

bunx wrangler d1 execute LEGACY_DB \
  --remote \
  --config "${config}" \
  --command "UPDATE agent_hosts SET disabled = 1, updated_at = ${now_ms} WHERE id = '${host_id}' AND name = '${host_name}' AND role = 'builder' AND organization_id IS NULL AND connected = 0 AND connected_at IS NULL AND last_heartbeat_at IS NULL AND last_inventory_at IS NULL AND NOT EXISTS (SELECT 1 FROM host_actual_state WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM host_desired_state WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM scenario_runs WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM runtime_executions WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM runtime_vm_actual_state WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM image_builds WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM host_resource_reservations WHERE host_id = '${host_id}' AND released_at IS NULL) AND NOT EXISTS (SELECT 1 FROM host_cpu_reservations WHERE host_id = '${host_id}') AND NOT EXISTS (SELECT 1 FROM workshop_publications WHERE builder_host_id = '${host_id}' AND status IN ('queued', 'building')) RETURNING id" \
  --json > "${host_update}"
jq -e \
  --arg host_id "${host_id}" '
    length == 1 and
    .[0].success == true and
    (.[0].results | length) == 1 and
    .[0].results[0].id == $host_id
  ' "${host_update}" >/dev/null

bunx wrangler d1 execute LEGACY_DB \
  --remote \
  --config "${config}" \
  --command "${state_sql}" \
  --json > "${after}"
jq -e '
  length == 1 and
  .[0].success == true and
  (.[0].results | length) == 1 and
  .[0].results[0].matching_hosts == 1 and
  .[0].results[0].personal_builder_hosts == 1 and
  .[0].results[0].disabled_hosts == 1 and
  .[0].results[0].never_connected_hosts == 1 and
  .[0].results[0].actual_state_rows == 0 and
  .[0].results[0].desired_state_rows == 0 and
  .[0].results[0].scenario_run_rows == 0 and
  .[0].results[0].runtime_execution_rows == 0 and
  .[0].results[0].runtime_vm_actual_state_rows == 0 and
  .[0].results[0].image_build_rows == 0 and
  .[0].results[0].active_resource_reservations == 0 and
  .[0].results[0].active_cpu_reservations == 0 and
  .[0].results[0].active_workshop_publications == 0 and
  .[0].results[0].active_bootstrap_tokens == 0
' "${after}" >/dev/null

jq -n \
  --arg source_sha "${GITHUB_SHA:-local}" \
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg host_id "${host_id}" \
  --arg host_name "${host_name}" \
  --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile before "${before}" \
  --slurpfile after "${after}" '
    {
      schema_version: 1,
      operation: "retire-unused-legacy-host",
      source_sha: $source_sha,
      database_name: $database_name,
      database_id: $database_id,
      host_id: $host_id,
      host_name: $host_name,
      before: $before[0][0].results[0],
      after: $after[0][0].results[0],
      host_deleted: false,
      host_disabled: true,
      bootstrap_tokens_revoked: true,
      publication_history_preserved: (
        $before[0][0].results[0].workshop_publication_history ==
        $after[0][0].results[0].workshop_publication_history
      ),
      observed_at: $observed_at
    }
  ' > "${evidence}"

jq -e '
  .schema_version == 1 and
  .host_deleted == false and
  .host_disabled == true and
  .bootstrap_tokens_revoked == true and
  .publication_history_preserved == true and
  .after.disabled_hosts == 1 and
  .after.active_bootstrap_tokens == 0
' "${evidence}" >/dev/null
