#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: prove-legacy-drain.sh <database-name> <database-id> <phase> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly phase="$3"
readonly evidence="$4"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-clean-d1-drain-${GITHUB_RUN_ID:-local}-${phase}"
readonly config="${runtime_root}/wrangler.jsonc"
readonly raw="${runtime_root}/d1.json"
readonly provider="${runtime_root}/provider.json"
readonly stargate_raw="${runtime_root}/stargate-plan.txt"
readonly stargate="${runtime_root}/stargate.json"

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${phase}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_D1_API_TOKEN:-}"
test -n "${CLOUDFLARE_PROVIDER_PROBE_API_TOKEN:-}"
test -n "${STARGATE_SSH_CONFIG:-}"
test -f "${STARGATE_SSH_CONFIG}"
test ! -L "${STARGATE_SSH_CONFIG}"

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"
jq -n \
  --arg name "${database_name}" \
  --arg id "${database_id}" \
  '{name: "intar-clean-d1-legacy-drain", compatibility_date: "2026-07-09", d1_databases: [{binding: "LEGACY_DB", database_name: $name, database_id: $id}]}' \
  > "${config}"

readonly drain_sql="$(tr '\n' ' ' <<'SQL'
SELECT
  (SELECT count(*) FROM active_runtime_slots) AS active_runtime_slots,
  (SELECT count(*) FROM runtime_executions WHERE ended_at IS NULL) AS unended_runtime_executions,
  (SELECT count(*) FROM hetzner_allocations WHERE deletion_confirmed_at IS NULL) AS unconfirmed_hetzner_allocations,
  (SELECT count(*) FROM workshop_publication_provider_attempts WHERE deletion_confirmed_at IS NULL) AS unconfirmed_publication_provider_attempts,
  (SELECT count(*) FROM runtime_provider_cost_ledger WHERE deletion_confirmed_at IS NULL) AS open_runtime_provider_cost_entries,
  (SELECT count(*) FROM workshop_publication_provider_cost_ledger WHERE deletion_confirmed_at IS NULL) AS open_publication_provider_cost_entries,
  (SELECT count(*) FROM organization_provider_connections WHERE state != 'disconnected') AS connected_provider_connections,
  (SELECT count(*) FROM organization_provider_connections WHERE active_credential_version_id IS NOT NULL) AS active_provider_credentials,
  (SELECT count(*) FROM runtime_terminal_sessions WHERE ended_at IS NULL) AS open_runtime_terminal_sessions,
  (SELECT count(*) FROM runtime_artifacts WHERE upload_status = 'pending') AS pending_runtime_artifacts,
  (SELECT count(*) FROM runtime_provider_artifact_upload_grants WHERE used_at IS NULL AND expires_at > cast(unixepoch('subsecond') * 1000 as integer)) AS active_provider_artifact_grants,
  (SELECT count(*) FROM workshop_assist_grants WHERE revoked_at IS NULL AND expires_at > cast(unixepoch('subsecond') * 1000 as integer)) AS active_workshop_assist_grants,
  (SELECT count(*) FROM workshop_help_requests WHERE status IN ('open', 'claimed')) AS active_workshop_help_requests,
  (SELECT count(*) FROM workshop_route_issuance_intents WHERE state IN ('pending', 'issued')) AS live_workshop_route_issuance_intents,
  (SELECT count(*) FROM runtime_allocation_locks) AS runtime_allocation_locks,
  (SELECT count(*) FROM host_resource_reservations WHERE released_at IS NULL) AS active_host_resource_reservations,
  (SELECT count(*) FROM host_cpu_reservations) AS active_host_cpu_reservations,
  (SELECT count(*) FROM image_builds WHERE status IN ('queued', 'assigned', 'building')) AS active_image_builds,
  (SELECT count(*) FROM image_build_coordination_locks) AS image_build_coordination_locks,
  (SELECT coalesce(sum(json_array_length(doc_json, '$.vms')), 0) FROM host_desired_state) AS host_desired_vm_entries,
  (SELECT coalesce(sum(json_array_length(doc_json, '$.builds')), 0) FROM host_desired_state) AS host_desired_build_entries,
  (SELECT coalesce(sum(json_array_length(report_json, '$.vms')), 0) FROM host_actual_state) AS host_actual_vm_entries,
  (SELECT coalesce(sum(json_array_length(report_json, '$.builds')), 0) FROM host_actual_state) AS host_actual_build_entries,
  (SELECT count(*) FROM runtime_vm_actual_state WHERE phase <> 'absent') AS nonabsent_runtime_vm_actual_states,
  (SELECT count(*)
   FROM agent_hosts host
   LEFT JOIN host_actual_state actual ON actual.host_id = host.id
   LEFT JOIN host_desired_state desired ON desired.host_id = host.id
   WHERE host.disabled = 0
     AND ((host.role = 'agent' AND host.scenario_enabled = 1) OR host.role = 'builder')
     AND (
       host.connected = 0
       OR host.last_heartbeat_at IS NULL
       OR host.last_heartbeat_at < cast(unixepoch('subsecond') * 1000 as integer) - 90000
       OR actual.host_id IS NULL
       OR actual.updated_at < cast(unixepoch('subsecond') * 1000 as integer) - 90000
       OR (desired.host_id IS NOT NULL AND actual.applied_desired_version < desired.version)
     )) AS untrustworthy_enabled_host_reports,
  (SELECT count(*) FROM workshop_publications WHERE status IN ('queued', 'building')) AS active_workshop_publications,
  (SELECT count(*) FROM workshop_publication_checkpoints WHERE status IN ('pending', 'building')) AS active_workshop_publication_checkpoints,
  (SELECT count(*) FROM workshop_publication_provider_checkpoints WHERE verification_status IN ('pending', 'allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'cleanup_pending')) AS active_publication_provider_checkpoints,
  (SELECT count(*) FROM workshop_sessions WHERE state NOT IN ('ended', 'cancelled')) AS nonterminal_workshop_sessions,
  (SELECT count(*) FROM workshop_workspaces WHERE state NOT IN ('ended', 'failed')) AS nonterminal_workshop_workspaces,
  (SELECT count(*) FROM workshop_workspace_generations WHERE state NOT IN ('archived', 'failed')) AS nonterminal_workshop_generations,
  (SELECT count(*) FROM scenario_runs WHERE active_key IS NOT NULL) AS active_scenario_runs,
  cast(unixepoch('subsecond') * 1000 as integer) AS observed_at;
SQL
)"

query_succeeded=false
provider_succeeded=false
stargate_succeeded=false
if CLOUDFLARE_API_TOKEN="${CLOUDFLARE_D1_API_TOKEN}" \
  bunx wrangler d1 execute LEGACY_DB \
    --remote \
    --config "${config}" \
    --command "${drain_sql}" \
    --json > "${raw}"; then
  query_succeeded=true
fi
if [ "${query_succeeded}" = true ] && ! jq -e '
  length == 1 and
  .[0].success == true and
  (.[0].results | length) == 1 and
  (.[0].results[0].observed_at | type == "number")
' "${raw}" >/dev/null; then
  query_succeeded=false
fi

if [ "${query_succeeded}" = true ] && \
  CLOUDFLARE_API_TOKEN="${CLOUDFLARE_PROVIDER_PROBE_API_TOKEN}" \
  bun "${repository_root}/tools/cutover/probe-legacy-provider-inventory.ts" \
    "${database_name}" "${database_id}" "${provider}"; then
  provider_succeeded=true
fi

if ssh -F "${STARGATE_SSH_CONFIG}" \
  intar-stargate-production plan > "${stargate_raw}" && \
  bun "${repository_root}/tools/cutover/stargate-plan.ts" \
    "${stargate_raw}" "${stargate}"; then
  stargate_succeeded=true
fi

if ! jq empty "${raw}" >/dev/null 2>&1; then
  jq -n '[]' > "${raw}"
fi
if ! jq empty "${provider}" >/dev/null 2>&1; then
  jq -n 'null' > "${provider}"
fi
if ! jq empty "${stargate}" >/dev/null 2>&1; then
  jq -n 'null' > "${stargate}"
fi

jq -n \
  --arg source_sha "${GITHUB_SHA:-local}" \
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg phase "${phase}" \
  --argjson query_succeeded "${query_succeeded}" \
  --argjson provider_succeeded "${provider_succeeded}" \
  --argjson stargate_succeeded "${stargate_succeeded}" \
  --slurpfile d1 "${raw}" \
  --slurpfile provider "${provider}" \
  --slurpfile stargate "${stargate}" '
    ($d1[0][0].results[0] // null) as $row |
    ($provider[0] // null) as $provider_evidence |
    ($stargate[0] // null) as $stargate_evidence |
    {
      schema_version: 3,
      operation: "legacy-drain",
      phase: $phase,
      source_sha: $source_sha,
      database_name: $database_name,
      database_id: $database_id,
      query_succeeded: $query_succeeded,
      provider_probe_succeeded: $provider_succeeded,
      stargate_probe_succeeded: $stargate_succeeded,
      observed_at: ($row.observed_at // null),
      counts: (if $row == null then null else ($row | del(.observed_at)) end),
      provider_inventory: $provider_evidence,
      stargate: $stargate_evidence,
      drained: (
        $query_succeeded and
        $provider_succeeded and
        $stargate_succeeded and
        $row != null and
        (($row | del(.observed_at) | to_entries) | length) > 0 and
        (($row | del(.observed_at) | to_entries) | all(.value == 0)) and
        $provider_evidence.provenEmpty == true and
        $stargate_evidence.healthy == true and
        $stargate_evidence.drained == true
      )
    }
  ' > "${evidence}"

jq -e '
  .schema_version == 3 and
  .query_succeeded == true and
  .provider_probe_succeeded == true and
  .stargate_probe_succeeded == true and
  .drained == true and
  (.counts | type == "object") and
  .provider_inventory.connectionCount > 0 and
  .provider_inventory.provenEmpty == true and
  .stargate.healthy == true and
  .stargate.drained == true
' "${evidence}" >/dev/null
