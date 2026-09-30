#!/usr/bin/env bash
# Website workflow, deploy job, step "Capture pre-migration D1 evidence".
set -euo pipefail
d1_info="${RUNNER_TEMP}/production-d1-info.json"
bookmark="${RUNNER_TEMP}/production-d1-bookmark.json"
run_drain_audit="${RUNNER_TEMP}/pre-migration-run-drain-audit.json"
assignment_counts="${RUNNER_TEMP}/pre-migration-assignment-counts.json"
enabled_scenarios="${RUNNER_TEMP}/pre-migration-enabled-scenarios.json"
query_request="${RUNNER_TEMP}/pre-migration-d1-query-request.json"

curl --fail-with-body --silent --show-error \
  --request GET \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE_ID}" \
  > "${d1_info}"
jq -e --arg database_id "${DATABASE_ID}" '
  .success == true and
  .result.uuid == $database_id and
  (.result.name | type == "string" and length > 0) and
  .result.version == "production"
' "${d1_info}" >/dev/null

curl --fail-with-body --silent --show-error \
  --request GET \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE_ID}/time_travel/bookmark" \
  > "${bookmark}"
jq -e '
  .success == true and
  (.result.bookmark | type == "string" and
  test("^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$")
  )
' "${bookmark}" >/dev/null

d1_readonly_query() {
  local sql="$1"
  local evidence="$2"
  jq -cn --arg sql "${sql}" '{sql: $sql, params: []}' \
    > "${query_request}"
  curl --fail-with-body --silent --show-error \
    --request POST \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data-binary "@${query_request}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query" \
    > "${evidence}"
  jq -e '
    .success == true and
    (.result | type == "array" and length == 1) and
    .result[0].success == true and
    (.result[0].results | type == "array")
  ' "${evidence}" >/dev/null
}

run_drain_sql="SELECT
    -- The two zero counts are enforced. The enabled-host count and the
    -- cutover gate state are evidence only.
    (SELECT COUNT(*) FROM scenario_runs
      WHERE hidden_at IS NULL AND
        (active_key IS NOT NULL OR state NOT IN ('completed', 'failed')))
      AS active_scenario_run_count,
    (SELECT COUNT(*) FROM scenario_run_artifacts
      WHERE upload_status <> 'uploaded')
      AS non_uploaded_run_artifact_count,
    (SELECT COUNT(*) FROM agent_hosts
      WHERE role = 'agent' AND disabled = 0)
      AS enabled_agent_host_count,
    (SELECT state FROM runtime_operation_gates
      WHERE key = 'image_cutover')
      AS cutover_gate_state;"
d1_readonly_query "${run_drain_sql}" "${run_drain_audit}"
jq -e '
  (.result[0].results | length == 1) and
  .result[0].results[0].active_scenario_run_count == 0 and
  .result[0].results[0].non_uploaded_run_artifact_count == 0
' "${run_drain_audit}" >/dev/null

assignment_counts_sql='SELECT organization_id, scenario_id,
    COUNT(*) AS assignment_count
  FROM scenario_assignments
  GROUP BY organization_id, scenario_id
  ORDER BY organization_id, scenario_id;'
d1_readonly_query "${assignment_counts_sql}" "${assignment_counts}"

enabled_scenarios_sql="SELECT scenario_id,
    CASE
      WHEN organization_id IS NULL THEN 'public'
      ELSE 'organization:' || organization_id
    END AS scope_key
  FROM vm_scenarios
  WHERE enabled = 1
  ORDER BY scope_key, scenario_id;"
d1_readonly_query "${enabled_scenarios_sql}" "${enabled_scenarios}"
