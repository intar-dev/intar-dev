#!/usr/bin/env bash
# image-ops workflow, cleanup job, "Resolve one stalled sweep" step.
set -euo pipefail
evidence_dir="${RUNNER_TEMP}/intar-image-registry-cleanup"
state_file="${evidence_dir}/state.json"
reap_file="${evidence_dir}/stalled-sweep-resolution.json"
post_file="${evidence_dir}/stalled-sweep-post-state.json"
test -n "${INTAR_IMAGE_PUBLISH_TOKEN}"

# Every precondition is read from the status step's record, which came
# from the collector itself and from D1. This resolves exactly one named
# abandoned sweep: one running GC run, that id, its heartbeat and lease
# already past the grace window, the plane healthy and open, the child in
# delete with enforcement on, and no other outstanding work.
jq -e --arg id "${EXPECTED_GC_RUN_ID}" --argjson stale "${STALE_MS}" '
  # The ledger window carries history, so only the running rows are the
  # guard: exactly one sweep may be in flight, and it must be the named
  # run. A completed row is the record of an earlier pass and is kept.
  [.gc_runs[] | select(.state == "running")] as $running |
  ($running[0] // {}) as $sweep |
  (.admission // {}) as $admission |
  # jq orders null below every number, so an unreadable stamp would
  # satisfy the lease test below instead of failing it.
  (($sweep.heartbeat_at | type) == "number") and
  (($admission.sweep_heartbeat_at | type) == "number") and
  (($admission.sweep_expires_at | type) == "number") and
  (.collector_http_status == 200) and
  (.collector_problem == null) and
  (.ledger_problem == null) and
  (.collector |
    (.maintenance == "off") and
    (.maintenance_source == "control-plane") and
    (.mode == "delete") and
    (.enforcement == "enforce") and
    (.session_required == true) and
    (.active_sessions == 0) and
    (.active_writers == 0)) and
  (.counts |
    (.running_gc_runs == 1) and
    (.open_sessions == 0) and
    (.pending_writers == 0)) and
  (($running | length) == 1) and
  ($sweep.id == $id) and
  ($admission.admission_state == "sweeping") and
  # Acquisition writes both rows from one clock reading.
  ($admission.sweep_started_at == $sweep.started_at) and
  # A recorded batch advances the row heartbeat alone, so the row is
  # legitimately at or ahead of the gate heartbeat.
  ($sweep.heartbeat_at >= $admission.sweep_heartbeat_at) and
  # Both heartbeats, and the lease, must be past the grace window: the
  # same two stamps the reap statement itself tests.
  ((.observed_at_ms - $sweep.heartbeat_at) > $stale) and
  ((.observed_at_ms - $admission.sweep_heartbeat_at) > $stale) and
  ((.observed_at_ms - $admission.sweep_expires_at) > $stale)
' "${state_file}" >/dev/null || {
  echo 'the stalled-sweep preconditions do not hold for that gc run id.' >&2
  jq -c '{counts, running_gc_runs: [.gc_runs[] | select(.state == "running") | {id, heartbeat_at}], admission: {admission_state: .admission.admission_state, sweep_heartbeat_at: .admission.sweep_heartbeat_at, sweep_expires_at: .admission.sweep_expires_at}, observed_at_ms, collector: {mode: .collector.mode, enforcement: .collector.enforcement, maintenance: .collector.maintenance}}' "${state_file}" >&2
  exit 1
}

# The existing operator endpoint. The body carries no credential, and
# the token travels only in this call's authorization header.
request_body="$(jq -cn --argjson grace "${STALE_MS}" '{resolve_stalled_sweeps: true, grace_ms: $grace}')"
reap_status="$(printf '%s' "${request_body}" | curl --silent --show-error --max-time 60 \
  --request POST \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  --output "${reap_file}" --write-out '%{http_code}' \
  "${REAP_URL}" || true)"
unset request_body
test "${reap_status}" = 200 || {
  echo "the stalled-sweep resolution answered HTTP ${reap_status:-none}." >&2
  exit 1
}

# Exactly one sweep resolved, and nothing else touched: no session and
# no writer was reaped, which is what a bounded resolution looks like.
jq -e '
  (.ok == true) and
  ((.reaped_sessions | length) == 0) and
  ((.reaped_writers | length) == 0) and
  ((.resolved_sweeps | length) == 1) and
  (.sweep_active == false) and
  (.active.sessions == 0) and
  (.active.writers == 0)
' "${reap_file}" >/dev/null || {
  echo 'the resolution did not reap exactly one sweep with nothing else.' >&2
  jq -c '{ok, reaped_sessions, reaped_writers, resolved_sweeps, active, sweep_active, sweep_stalled}' "${reap_file}" >&2
  exit 1
}

# Fresh state, not the response: one query bound to the run id proves the
# row is aborted, the gate is open with no sweep fields, nothing is running,
# and the claimed counters this sweep had already written are preserved.
query_sql="SELECT
    (SELECT state FROM image_registry_gc_runs WHERE id = ?1) AS gc_state,
    (SELECT finished_at FROM image_registry_gc_runs WHERE id = ?1) AS gc_finished_at,
    (SELECT scanned_objects FROM image_registry_gc_runs WHERE id = ?1) AS scanned_objects,
    (SELECT deleted_objects FROM image_registry_gc_runs WHERE id = ?1) AS deleted_objects,
    (SELECT blocked_objects FROM image_registry_gc_runs WHERE id = ?1) AS blocked_objects,
    (SELECT bytes_reclaimed FROM image_registry_gc_runs WHERE id = ?1) AS bytes_reclaimed,
    (SELECT state FROM image_registry_admission) AS admission_state,
    (SELECT sweep_started_at FROM image_registry_admission) AS sweep_started_at,
    (SELECT sweep_heartbeat_at FROM image_registry_admission) AS sweep_heartbeat_at,
    (SELECT sweep_expires_at FROM image_registry_admission) AS sweep_expires_at,
    (SELECT COUNT(*) FROM image_registry_gc_runs WHERE state = 'running') AS running_gc_runs;"
jq -cn --arg sql "${query_sql}" --arg id "${EXPECTED_GC_RUN_ID}" '{sql: $sql, params: [$id]}' \
  > "${evidence_dir}/stalled-sweep-post-request.json"
post_status="$(curl --silent --show-error --max-time 60 \
  --request POST \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data-binary "@${evidence_dir}/stalled-sweep-post-request.json" \
  --output "${post_file}" --write-out '%{http_code}' \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query" \
  || true)"
test "${post_status}" = 200 || {
  echo "the post-resolution state read answered HTTP ${post_status:-none}." >&2
  exit 1
}
# The comparison row is the named run, selected by id: the ledger window
# may also hold completed history.
jq -e --argjson before "$(jq -c --arg id "${EXPECTED_GC_RUN_ID}" '[.gc_runs[] | select(.id == $id)][0]' "${state_file}")" '
  (.success == true) and
  (.result[0].success == true) and
  (.result[0].results | length == 1) and
  (.result[0].results[0]) as $r |
  ($r.gc_state == "aborted") and
  ($r.gc_finished_at != null) and
  ($r.running_gc_runs == 0) and
  ($r.admission_state == "open") and
  ($r.sweep_started_at == null) and
  ($r.sweep_heartbeat_at == null) and
  ($r.sweep_expires_at == null) and
  ($r.scanned_objects == $before.scanned_objects) and
  ($r.deleted_objects == $before.deleted_objects) and
  ($r.blocked_objects == $before.blocked_objects) and
  ($r.bytes_reclaimed == $before.bytes_reclaimed)
' "${post_file}" >/dev/null || {
  echo 'the aborted sweep is not the expected state, or its counters moved.' >&2
  jq -c '.result[0].results[0]' "${post_file}" >&2
  exit 1
}
# Staged, not written straight to the summary: a failed step's summary
# can not be retracted, so the credential check below runs first, exactly
# as the status step does.
summary_file="${evidence_dir}/stalled-sweep-summary.jsonl"
jq -c '{reaped_sessions: (.reaped_sessions | length), reaped_writers: (.reaped_writers | length), resolved_sweeps: (.resolved_sweeps | length), sweep_active, sweep_stalled}' "${reap_file}" \
  > "${summary_file}"
jq -c '.result[0].results[0]' "${post_file}" >> "${summary_file}"
reflected=0
for secret in "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET:-}" "${INTAR_IMAGE_PUBLISH_TOKEN:-}" "${CLOUDFLARE_API_TOKEN:-}"; do
  # An absent credential can not be reflected by anything.
  [ -n "${secret}" ] || continue
  for candidate in "${evidence_dir}"/*; do
    [ -f "${candidate}" ] || continue
    if grep -qF -- "${secret}" "${candidate}" 2>/dev/null; then
      rm -f -- "${candidate}"
      echo "removed a file that reflected a machine credential: ${candidate}" >&2
      reflected=1
    fi
  done
done
if [ "${reflected}" = 1 ]; then
  echo 'an answer reflected a machine credential, so nothing was summarised.' >&2
  exit 1
fi
cat "${summary_file}" >> "${GITHUB_STEP_SUMMARY}"
