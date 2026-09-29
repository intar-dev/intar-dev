#!/usr/bin/env bash
# image-ops workflow, cleanup job, "Read the collector status and the shared ledger" step.
set -euo pipefail
evidence_dir="${RUNNER_TEMP}/intar-image-registry-cleanup"
state_file="${evidence_dir}/state.json"
collector_file="${evidence_dir}/collector-status.json"
collector_http_status=''
collector_problem=''
ledger_problem=''

# The request body carries the machine credential, so it is built from
# the environment, piped on standard input, and never printed.
collector_http_status="$(
  BYPASS_SECRET="${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}" \
    jq -cn '{secret: env.BYPASS_SECRET, action: "status"}' \
    | curl --silent --show-error --max-time 60 \
        --request POST \
        --header 'Content-Type: application/json' \
        --data-binary @- \
        --output "${collector_file}" --write-out '%{http_code}' \
        "${GATE_URL}" || true
)"
if [ "${collector_http_status}" != 200 ]; then
  collector_problem="the parent maintenance action answered HTTP ${collector_http_status:-none}"
  : > "${collector_file}"
fi

# Read-only. The admission row is named one row by its primary key, and
# the GC rows are the recent ledger window. Neither sweep_token nor
# owner is selected: they are per-run tokens, not state an operator
# needs, and they never leave the database.
query_ledger() {
  local name="$1"
  local sql="$2"
  local reply="${evidence_dir}/d1-${name}.json"
  local request="${evidence_dir}/d1-${name}-request.json"
  local status
  jq -cn --arg sql "${sql}" '{sql: $sql, params: []}' > "${request}"
  status="$(curl --silent --show-error --max-time 60 \
    --request POST \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data-binary "@${request}" \
    --output "${reply}" --write-out '%{http_code}' \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query" \
    || true)"
  if [ "${status}" != 200 ] || \
    ! jq -e '.success == true and (.result | type == "array") and
      (.result | length == 1) and (.result[0].success == true) and
      (.result[0].results | type == "array")' "${reply}" >/dev/null 2>&1; then
    ledger_problem="${ledger_problem}${ledger_problem:+, }the ${name} query answered HTTP ${status:-none}"
    printf '{"result":[{"success":false,"results":[]}]}' > "${reply}"
  fi
}
query_ledger admission \
  "SELECT key, protocol_version, enforcement, epoch, state, sweep_started_at, sweep_heartbeat_at, sweep_expires_at, paused_at, pause_reason, updated_at FROM image_registry_admission"
query_ledger gc-runs \
  "SELECT id, state, started_at, heartbeat_at, finished_at, scanned_objects, deleted_objects, blocked_objects, bytes_reclaimed, error, detail_json, created_at, updated_at FROM image_registry_gc_runs ORDER BY started_at DESC LIMIT 5"
query_ledger counts \
  "SELECT (SELECT COUNT(*) FROM image_registry_gc_runs WHERE state = 'running') AS running_gc_runs, (SELECT COUNT(*) FROM image_registry_upload_sessions WHERE state = 'open') AS open_sessions, (SELECT COUNT(*) FROM image_registry_operation_writers WHERE released_at IS NULL OR outcome = 'unknown') AS pending_writers"

# One record for an operator and for the plan and run preconditions. The
# raw bodies stay as their own files, so this names the scalars instead
# of copying them twice.
jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --arg action "${ACTION}" \
  --arg collector_http_status "${collector_http_status}" \
  --arg collector_problem "${collector_problem}" \
  --arg ledger_problem "${ledger_problem}" \
  --slurpfile collector "${collector_file}" \
  --slurpfile admission "${evidence_dir}/d1-admission.json" \
  --slurpfile gc_runs "${evidence_dir}/d1-gc-runs.json" \
  --slurpfile counts "${evidence_dir}/d1-counts.json" \
  '($collector[0] // {}) as $raw |
   ($raw.result // {}) as $report |
   ($admission[0].result[0].results[0] // null) as $row |
   ($counts[0].result[0].results[0] // null) as $totals |
   {
     schema_version: 1,
     operation: "image-registry-cleanup-state",
     source_sha: $source_sha,
     run_id: $run_id,
     action: $action,
     observed_at_ms: (now * 1000 | floor),
     collector_http_status: ($collector_http_status | tonumber? // null),
     collector_problem: (if ($collector_problem | length) == 0 then null else $collector_problem end),
    collector: {
      mode: ($report.mode // null),
      # Booleans are read directly. `// null` treats a present false
      # as absent, which would erase exactly the answer that matters
      # most here, and a missing field already yields null.
      mode_valid: $report.modeValid,
      configured_mode: ($report.configuredMode // null),
      maintenance: ($report.maintenance // null),
      maintenance_source: ($report.maintenanceSource // null),
      enforcement: ($report.enforcement // null),
      session_required: $report.sessionRequired,
      paused: $report.paused,
      pause_reason: ($report.pauseReason // null),
      sweep_active: $report.sweepActive,
      running: $report.running,
      idle: $report.idle,
       active_sessions: ($report.activeSessions // null),
       active_writers: ($report.activeWriters // null),
       last_run: ($report.lastRun // null),
       observed_at_ms: ($report.observedAtMs // null)
     },
     admission_problem: (if ($admission[0].result[0].success // false) then null else "the admission row could not be read" end),
     admission: (if $row == null then null else {
       enforcement: $row.enforcement,
       admission_state: $row.state,
       protocol_version: $row.protocol_version,
       epoch: $row.epoch,
       sweep_started_at: $row.sweep_started_at,
       sweep_heartbeat_at: $row.sweep_heartbeat_at,
       sweep_expires_at: $row.sweep_expires_at,
       paused_at: $row.paused_at,
       pause_reason: $row.pause_reason,
       updated_at: $row.updated_at
     } end),
     ledger_problem: (if ($ledger_problem | length) == 0 then null else $ledger_problem end),
     counts: (if $totals == null then null else {
       running_gc_runs: $totals.running_gc_runs,
       open_sessions: $totals.open_sessions,
       pending_writers: $totals.pending_writers
     } end),
     gc_runs: ($gc_runs[0].result[0].results // []),
     idle: (
       ($report.paused == false) and
       ($report.sweepActive == false) and
       ($report.activeSessions == 0) and
       ($report.activeWriters == 0) and
       (($totals.running_gc_runs // 1) == 0)
     )
   }' > "${state_file}"

jq -c '{collector_http_status, collector: .collector, admission, counts, gc_runs: (.gc_runs | length), idle, collector_problem, ledger_problem}' \
  "${state_file}" > "${evidence_dir}/state-summary.jsonl"

# The summary is written only from files that proved clean, because a
# failed run's step summary can not be retracted by deleting evidence
# afterwards. A reflected credential is still reported, without its
# value, and the step stops before anything is summarised.
reflected=0
for candidate in "${evidence_dir}"/*; do
  [ -f "${candidate}" ] || continue
  if grep -qF -- "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}" "${candidate}" 2>/dev/null; then
    rm -f -- "${candidate}"
    echo "removed a file that reflected the machine credential: ${candidate}" >&2
    reflected=1
  fi
done
if [ "${reflected}" = 1 ]; then
  echo 'an answer reflected the maintenance bypass secret, so nothing was summarised.' >&2
  exit 1
fi
cat "${evidence_dir}/state-summary.jsonl" >> "${GITHUB_STEP_SUMMARY}"

# Visibility is the point of this step, so the record is written before
# the decision. Unreadable input still stops the step: plan and run must
# never act on a state they could not read.
if [ -n "${collector_problem}" ]; then
  echo "${collector_problem}" >&2
  exit 1
fi
if [ -n "${ledger_problem}" ]; then
  echo "${ledger_problem}" >&2
  exit 1
fi
