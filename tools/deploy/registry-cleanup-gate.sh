#!/usr/bin/env bash
# Hold, release, or read the image registry cleanup collector.
#
#   usage: tools/deploy/registry-cleanup-gate.sh <hold|release|plan|run> <target-mode> <evidence.json>
#
# The collector publishes no route. Every call travels to the parent worker on
# POST /api/maintenance/registry-cleanup, which holds the service binding to the
# collector. The contract of that route is .work/registry-control-contract.md;
# the deploy lane is its caller of record.
#
# Two pieces of live state decide what this script does:
#   * the Cloudflare API says whether a collector version exists at all;
#   * the collector's own status says what D1 upload admission enforcement is.
# An unreadable answer of either kind stops the deployment. Nothing here reads
# LEARNER_RUN_CLI_V1_ENFORCEMENT: that variable controls the learner-run CLI
# rollout and has nothing to do with registry admission.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: tools/deploy/registry-cleanup-gate.sh <hold|release|plan|run> <target-mode> <evidence.json>" >&2
  exit 64
fi

readonly action="$1"
readonly target_mode="$2"
readonly evidence="$3"
readonly worker_name="intar-dev-image-registry-cleanup"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly gate_url="${REGISTRY_CLEANUP_GATE_URL:-https://intar.dev/api/maintenance/registry-cleanup}"
# The adapter compares a present Origin against the canonical one, so the lane
# sends exactly that; curl on its own would send none.
readonly gate_origin="${gate_url%%/api/*}"
readonly wait_ms="${REGISTRY_CLEANUP_WAIT_MS:-60000}"
# One delete campaign is bounded twice: by passes and by wall clock. The loop
# is never unbounded, and a pass that fails is never retried as if it were
# contention.
readonly run_max_passes="${REGISTRY_CLEANUP_RUN_PASSES:-64}"
readonly run_deadline_ms="${REGISTRY_CLEANUP_RUN_DEADLINE_MS:-900000}"
readonly run_sleep_s="${REGISTRY_CLEANUP_RUN_SLEEP_S:-5}"
# The request ceiling follows the action. A pass scans the bucket and then
# deletes what the scan listed, so it is not one read: a plan of about 94,000
# objects already measures at 87 s. A pass gets 10 minutes, so a 60-minute
# campaign can overrun by one pass and still fit the 75-minute job; the other
# actions keep 120 s.
readonly call_timeout_s=120
readonly run_call_timeout_s=600
# Key lists are evidence, not a data dump: every list in the record is capped.
readonly max_evidence_keys=5000
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-registry-cleanup-gate-${GITHUB_RUN_ID:-local}"
readonly deployment="${runtime_root}/deployment.json"
readonly version="${runtime_root}/version.json"
readonly response="${runtime_root}/response.json"
readonly plan_response="${runtime_root}/plan-response.json"
readonly status_response="${runtime_root}/status-response.json"
readonly pass_response="${runtime_root}/pass-response.json"
readonly final_report_response="${runtime_root}/final-report.json"
# The campaign journal and its record live on disk, never in a shell variable:
# one pass carries up to max_evidence_keys keys, which is far past the 128 KiB
# a Linux argument may hold.
readonly campaign_passes="${runtime_root}/campaign-passes.json"
readonly campaign_record="${runtime_root}/campaign-record.json"
readonly final_report_proof_json="${runtime_root}/final-report-proof.json"
readonly state="${runtime_root}/state.json"
readonly hold_evidence="${RUNNER_TEMP:-/tmp}/registry-cleanup-hold.json"

# Every file this step writes is uploaded as deployment evidence, even when
# the step fails, so no file may carry the machine credential. Any file that
# does is destroyed, and the exit trap makes that true for every exit path,
# including an abort from `set -e`. Deleting is deliberate: a sanitized file
# would still describe a run whose bytes can no longer be trusted.
scrub_secret_files() {
  local secret="${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET:-}"
  local removed=0 candidate
  if [ -z "${secret}" ]; then
    return 0
  fi
  for candidate in "${evidence}" "${hold_evidence}" "${runtime_root}"/*; do
    [ -f "${candidate}" ] || continue
    if grep -qF -- "${secret}" "${candidate}" 2>/dev/null; then
      rm -f -- "${candidate}"
      echo "removed a file that reflected the machine credential: ${candidate}" >&2
      removed=1
    fi
  done
  if [ "${removed}" = 1 ]; then
    return 1
  fi
  return 0
}

# A raw header dump holds whatever the answer carried, cookies included, so it
# never survives an exit. The names end in -headers.dump; only the traced copy
# of four named headers stays.
scrub_header_dumps() {
  rm -f "${runtime_root}"/*-headers.dump
}

# The evidence must not carry the credential the calls were authorized with.
require_clean_evidence() {
  if ! scrub_secret_files; then
    echo 'the deployment gate removed files that reflected the bypass secret.' >&2
    exit 1
  fi
}

on_exit_scrub() {
  local status=$?
  scrub_header_dumps
  if ! scrub_secret_files; then
    echo 'the deployment gate removed files that reflected the bypass secret before it exited.' >&2
    exit 1
  fi
  exit "${status}"
}
trap on_exit_scrub EXIT

mkdir -p "${runtime_root}"
# The bypass secret travels on standard input. Nothing in this directory may
# hold it: the deploy lane uploads the directory as deployment evidence.
chmod 700 "${runtime_root}"
# The evidence step reads these with jq --slurpfile, so they exist even when a
# skipped gate makes no call at all.
touch "${deployment}" "${response}" "${plan_response}" "${status_response}"
touch "${pass_response}" "${final_report_response}"
# The record starts as null, so the evidence build always has a file to read.
printf 'null\n' > "${campaign_record}"
test ! -e "${evidence}"
test -n "${GITHUB_SHA:-}"
test -n "${gate_origin}"
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"

case "${action}" in
  hold|release|plan|run) ;;
  *)
    echo "action must be hold, release, plan, or run" >&2
    exit 1
    ;;
esac
case "${target_mode}" in
  report-only|delete) ;;
  *)
    echo "target mode must be report-only or delete" >&2
    exit 1
    ;;
esac

# The four response headers a failed call is traced with. Each field is read by
# name, so a cookie, an authorization header, or anything else the answer
# carried can not reach the artifact.
write_traced_headers() {
  local dump="$1" out="$2" status="$3"
  [ -f "${dump}" ] || return 1
  jq -cn --rawfile headers "${dump}" --arg http_status "${status}" \
    '($headers | split("\n")) as $lines |
     def field($name):
       [$lines[] | select(test("^" + $name + ":"; "i"))
                | sub("^[^:]*:[ ]*"; "") | sub("\r$"; "")] | last;
     {http_status: ($http_status | tonumber? // null),
      server: field("server"),
      cf_ray: field("cf-ray"),
      content_type: field("content-type"),
      date: field("date")}' > "${out}"
}

# One authenticated call to the gate. The secret reaches jq through the
# environment, never through an argument list and never through a file.
# Prints the HTTP status and writes the body to the given file.
call_gate() {
  local gate_action="$1"
  local body_file="$2"
  # `${3:-{}}` would append a literal brace: bash closes the expansion at the
  # first `}`. The default is spelled out instead.
  local extra_json='{}'
  if [ "$#" -ge 3 ]; then extra_json="$3"; fi
  local request_json call_status max_time_s headers_dump traced_file
  request_json="$(BYPASS_SECRET="${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}" \
    jq -cn --arg gateAction "${gate_action}" --argjson extra "${extra_json}" \
    '{secret: env.BYPASS_SECRET, action: $gateAction} + $extra')"
  max_time_s="${call_timeout_s}"
  if [ "${gate_action}" = run ]; then max_time_s="${run_call_timeout_s}"; fi
  # The dump is a working file: it is read for the four traced names and then
  # deleted, so the answer's own bytes never reach the upload.
  headers_dump="${body_file%.json}-headers.dump"
  traced_file="${body_file%.json}-headers.json"
  rm -f "${headers_dump}"
  call_status="$(printf '%s' "${request_json}" | curl --silent --show-error \
    --max-time "${max_time_s}" \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Origin: ${gate_origin}" \
    --data-binary @- \
    --dump-header "${headers_dump}" \
    --output "${body_file}" --write-out '%{http_code}' \
    "${gate_url}" || true)"
  # A trace that can not be read is not a reason to fail the call, but it must
  # never leave a half-written file behind.
  if ! write_traced_headers "${headers_dump}" "${traced_file}" "${call_status}"; then
    rm -f "${traced_file}"
  fi
  rm -f "${headers_dump}"
  unset request_json
  printf '%s' "${call_status}"
}

# The 503 answers carry a code, and the code is what separates a fence from an
# absent collector from a parent without a secret. A fence that reads as an
# absent collector would skip a hold that was needed.
classify_gate_response() {
  local status="$1"
  local body_file="$2"
  local code=""
  code="$(jq -r '.code // ""' "${body_file}" 2>/dev/null || true)"
  case "${status}" in
    200) printf 'ok' ;;
    403) printf 'denied' ;;
    # The contract says this path has no 404. An older parent can still answer
    # one, and that means no gate, which is what `unavailable` records.
    404) printf 'unavailable' ;;
    503)
      case "${code}" in
        maintenance) printf 'fence' ;;
        registry_cleanup_unavailable) printf 'unavailable' ;;
        registry_cleanup_gate_unconfigured) printf 'unconfigured' ;;
        *) printf 'failed' ;;
      esac
      ;;
    *) printf 'failed' ;;
  esac
}

# Prints nothing for a usable answer and a diagnosis for a fatal one, so the
# caller decides whether the class is fatal for its action.
explain_fatal_gate_class() {
  local class="$1"
  local status="$2"
  local body_file="$3"
  local code
  code="$(jq -r '.code // ""' "${body_file}" 2>/dev/null || true)"
  case "${class}" in
    fence)
      echo 'The control plane is under maintenance, so the gate is fenced.' >&2
      echo 'Hold the collector before maintenance closes, and release it after the parent serves again.' >&2
      ;;
    denied)
      echo 'The deployment gate refused the request (HTTP 403).' >&2
      echo 'Check CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET and the origin of REGISTRY_CLEANUP_GATE_URL.' >&2
      ;;
    unconfigured)
      echo 'The parent has no usable bypass secret, so the deployment gate can not run.' >&2
      ;;
    *)
      echo "the registry cleanup deployment gate answered HTTP ${status}" >&2
      if [ -n "${code}" ]; then echo "code=${code}" >&2; fi
      ;;
  esac
}

# The D1 upload admission state is the one authority for whether an uploader
# can race the collector. The collector reads it from the shared database, so
# this answer is the same one the child asserts before it deletes. Sets
# admission_json and admission_problem.
take_admission_proof() {
  local status_status status_class
  status_status="$(call_gate status "${status_response}")"
  status_class="$(classify_gate_response "${status_status}" "${status_response}")"
  if [ "${status_class}" = ok ]; then
    admission_json="$(jq -c '
      (.result // .) as $report |
      {
        ok: true,
        http_status: 200,
        enforcement: ($report.enforcement // null),
        sessionRequired: (if $report.sessionRequired == true then true
                          elif $report.sessionRequired == false then false
                          else null end),
        paused: (if $report.paused == true then true
                 elif $report.paused == false then false else null end),
        sweepActive: (if $report.sweepActive == true then true
                      elif $report.sweepActive == false then false else null end),
        activeSessions: ($report.activeSessions // null),
        activeWriters: ($report.activeWriters // null)
      }' "${status_response}")"
  else
    admission_json="$(jq -cn \
      --arg status "${status_status}" \
      --arg class "${status_class}" \
      '{ok: false, http_status: $status, class: $class,
        enforcement: null, sessionRequired: null}')"
  fi
  admission_problem="$(jq -r '
    if (.ok // false) != true
      then "the collector status is unreadable (HTTP " + (.http_status | tostring) + ")"
    elif (.enforcement // "") == ""
      then "the collector status carries no enforcement field"
    elif .enforcement != "enforce"
      then "D1 upload admission enforcement is \"" + (.enforcement | tostring) + "\""
    elif .sessionRequired == null
      then "the collector status carries no sessionRequired field"
    elif .sessionRequired != true
      then "the collector reports sessionRequired=" + (.sessionRequired | tostring)
    else "ok" end' <<<"${admission_json}")"
}

# Turning deletes on is a change of authority, so it needs a successful report
# inventory from the collector that is about to delete: a live listing of the
# delete set, taken while the control plane still serves. The plan itself must
# prove completeness: a truncated listing, a fault, or a plan that withheld
# deletes by reference is not evidence for turning deletes on, whatever the
# envelope status says. Sets inventory_json and inventory_problem.
take_inventory_proof() {
  local plan_status plan_class
  plan_status="$(call_gate plan "${plan_response}")"
  plan_class="$(classify_gate_response "${plan_status}" "${plan_response}")"
  if [ "${plan_class}" != ok ]; then
    mark_inventory_unreadable "${plan_status}" "${plan_class}"
    return 0
  fi
  evaluate_plan_file "${plan_response}"
}

# A refusal is not a plan, so the inventory records the class that answered
# instead of reading fields that are not there.
mark_inventory_unreadable() {
  inventory_json="$(jq -cn \
    --arg status "$1" \
    --arg class "$2" \
    '{ok: false, http_status: ($status | tonumber? // null), gate_class: $class}')"
  inventory_problem="the inventory call answered HTTP $1"
}

# The plan checks of one envelope already in hand. One plan call is one bucket
# scan, so the callers that hold an answer evaluate it here instead of asking
# the collector again. Sets inventory_json and inventory_problem.
evaluate_plan_file() {
  local response_file="$1"
  inventory_json="$(jq -c '
    (.result // .) as $envelope |
    ($envelope.plan // null) as $plan |
    ($plan.details // {}) as $details |
    ($details.faults // null) as $faults |
    {
      status: ($envelope.status // null),
      plan_present: (($plan | type) == "object"),
      candidates: (($plan.candidateObjects // []) | length),
      candidates_total: ($details.candidateTotal // null),
      scanned_objects: ($plan.objectsScanned // null),
      # `//` would turn a boolean false into null, so presence is tested
      # with has() and the value is read directly.
      truncated: (if ($plan | type) == "object" and ($plan | has("truncated"))
                  then $plan.truncated else null end),
      delete_allowed_by_references:
        (if ($details | type) == "object" and ($details | has("deleteAllowedByReferences"))
         then $details.deleteAllowedByReferences else null end),
      faults: (if ($faults | type) == "array" then ($faults | length) else null end),
      # An empty fault list must produce an empty array, so the iteration
      # is inside the array and every element carries its own fallback.
      fault_codes: [($faults // [])[]? | (.code? // "unknown")],
      ok: (
        (($plan | type) == "object") and
        ($plan.truncated == false) and
        ($details.deleteAllowedByReferences == true) and
        (($faults | type) == "array") and
        (($faults | length) == 0)
      )
    }' "${response_file}")"
  inventory_problem="$(jq -r '
    # The status is named first: a fenced or failed pass explains itself, while
    # a missing plan only says the answer carried nothing to read.
    if (.status // "") == "" then "the collector reported no status"
    elif (.status != "report-only" and .status != "ok") then "the collector status is \"" + (.status | tostring) + "\""
    elif (.plan_present // false) != true then "the collector listed no plan"
    elif .truncated == null then "the plan carries no truncated flag"
    elif .truncated != false then "the bucket listing was truncated"
    elif .faults == null then "the plan carries no fault list"
    elif .faults != 0 then "the plan carries " + (.faults | tostring) + " fault(s): " + ((.fault_codes // []) | join(","))
    elif .delete_allowed_by_references == null then "the plan carries no deleteAllowedByReferences flag"
    elif .delete_allowed_by_references != true then "the plan withheld deletes by reference"
    else "ok" end' <<<"${inventory_json}")"
}

# A run record for a campaign that never started, so the evidence still names
# the reason and the caller exits non-zero.
run_refusal() {
  jq -cn --arg reason "$1" '{ok: false, reason: $reason, passes: 0, max_passes: 0,
    deadline_ms: 0, deleted_objects_total: 0, verified_deleted_objects_total: 0,
    post_state_digest: null, final_report: null, preflight: null, campaign: []}'
}

# The campaign journal is replaced atomically, so a jq that fails leaves every
# pass already recorded in place. Only paths and small scalars reach the
# argument list; pass data always arrives through a file.
append_failed_pass() {
  local pass="$1" status="$2" class="$3" error="$4"
  jq -cn --slurpfile passes "${campaign_passes}" \
    --argjson pass "${pass}" --arg status "${status}" --arg class "${class}" \
    --arg error "${error}" \
    '$passes[0] + [{pass: $pass, http_status: ($status | tonumber? // null),
                    gate_class: $class, status: null, completed: false,
                    error: $error}]' \
    > "${campaign_passes}.next" && mv -f "${campaign_passes}.next" "${campaign_passes}"
}

# Appends the record of one served pass, with its capped key lists.
append_served_pass() {
  local pass="$1" status="$2" class="$3" body="$4"
  jq -cn --slurpfile passes "${campaign_passes}" --slurpfile response "${body}" \
    --argjson pass "${pass}" --arg status "${status}" --arg class "${class}" \
    --argjson cap "${max_evidence_keys}" \
    '$passes[0] + [($response[0] // {}) as $outer |
      ($outer.result // $outer) as $envelope | ($envelope.result // {}) as $result |
      {pass: $pass, http_status: ($status | tonumber? // null), gate_class: $class,
       status: ($envelope.status // null), completed: ($result.completed // false),
       error: ($envelope.error // $result.error // null),
       deleted_objects: ($result.deletedObjects // 0),
       deleted_bytes: ($result.deletedBytes // 0),
       verified_deleted_objects: ($result.verifiedDeletedObjects // 0),
       verified_deleted_bytes: ($result.verifiedDeletedBytes // 0),
       failed_objects: ($result.failedObjects // 0),
       blocked_objects: ($result.blockedObjects // 0),
       resume_required: ($result.resumeRequired // false),
       candidate_total: ($result.planSummary.details.candidateTotal // null),
       post_state_unchanged: ($result.postState.unchanged // false),
       post_state_digest: ($result.postState.scanned.digest // null),
       deleted_keys: (($result.deletedKeys // [])[0:$cap]),
       deleted_keys_retained: ((($result.deletedKeys // []) | length) | if . > $cap then $cap else . end),
       deleted_keys_truncated: (($result.deletedKeysTruncated // false) or ((($result.deletedKeys // []) | length) > $cap)),
       unverified_keys: (($result.unverifiedKeys // [])[0:$cap]),
       unverified_keys_truncated: ((($result.unverifiedKeys // []) | length) > $cap)}]' \
    > "${campaign_passes}.next" && mv -f "${campaign_passes}.next" "${campaign_passes}"
}

# Replaces the campaign record with one merged field, read and written through
# files so the record never becomes an argument.
replace_campaign_record() {
  local program="$1"
  shift
  jq -cn "$program" "$@" > "${campaign_record}.next" \
    && mv -f "${campaign_record}.next" "${campaign_record}"
}

# One bounded delete campaign, then the proof that the backlog is gone.
#
# Writes the campaign record to campaign_record and never exits: the caller
# writes the evidence and decides the exit code, so a refused or unfinished
# campaign is still an artifact. A pass that fails is never retried as though
# it were contention.
#
# Every pass journals itself before the next one starts: an attempt row before
# the request, the raw body as it arrives, and its record once it is read. A
# pass carries up to max_evidence_keys keys, so no pass data may travel on an
# argument list.
run_cleanup_to_completion() {
  local pass=0 pass_status pass_class envelope_status completed=true
  local reason='' deadline_ms now_ms post_digest='' finished=false ok=false
  local pass_raw='' pass_attempt=''
  printf '[]' > "${campaign_passes}"
  deadline_ms=$(( $(date +%s) * 1000 + run_deadline_ms ))
  while [ "${pass}" -lt "${run_max_passes}" ]; do
    now_ms=$(( $(date +%s) * 1000 ))
    if [ "${now_ms}" -ge "${deadline_ms}" ]; then
      reason="the pass deadline of ${run_deadline_ms} ms expired after ${pass} pass(es)"
      completed=false
      break
    fi
    pass=$(( pass + 1 ))
    pass_raw="${runtime_root}/pass-${pass}-response.json"
    pass_attempt="${runtime_root}/pass-${pass}-attempt.json"
    # The attempt row is written before the request: a pass that never answers
    # can still have deleted, so the attempt outlives a body that never came.
    jq -cn --argjson pass "${pass}" --argjson started_ms "${now_ms}" \
      '{pass: $pass, started_at_ms: $started_ms}' > "${pass_attempt}"
    pass_status="$(call_gate run "${pass_raw}")"
    # The latest body keeps its old name, which the lane reads as evidence.
    cp -f "${pass_raw}" "${pass_response}"
    pass_class="$(classify_gate_response "${pass_status}" "${pass_response}")"
    if [ "${pass_class}" != ok ]; then
      append_failed_pass "${pass}" "${pass_status}" "${pass_class}" "${pass_class}"
      reason="pass ${pass} reached the gate with HTTP ${pass_status:-none} (${pass_class})"
      completed=false
      break
    fi
    # A body that does not parse is not contention, and the campaign must not
    # continue on an answer it could not read. The raw body stays on disk as it
    # arrived, so the operator can read what answered.
    if ! jq -e . >/dev/null 2>&1 < "${pass_raw}"; then
      append_failed_pass "${pass}" "${pass_status}" "${pass_class}" unparsed_body
      reason="pass ${pass} answered a body this lane could not parse"
      completed=false
      break
    fi
    envelope_status="$(jq -r '((.result // .) | .status) // empty' "${pass_raw}")"
    completed="$(jq -r '((.result // .) | .result.completed) // false | tostring' "${pass_raw}")"
    append_served_pass "${pass}" "${pass_status}" "${pass_class}" "${pass_raw}"
    if [ "${completed}" = true ]; then
      reason=''
      finished=true
      break
    fi
    case "${envelope_status}" in
      pending|busy)
        reason="the campaign stopped after ${pass} pass(es) with status ${envelope_status}"
        if [ "${run_sleep_s}" -gt 0 ]; then sleep "${run_sleep_s}"; fi
        ;;
      *)
        reason="pass ${pass} answered ${envelope_status:-nothing}, which is not a pass to retry"
        completed=false
        break
        ;;
    esac
  done
  if [ "${finished}" != true ] && [ -z "${reason}" ]; then
    # The loop fell out of its pass limit without a completion verdict.
    reason="the campaign reached its ${run_max_passes} pass limit"
  fi
  if [ "${finished}" = true ]; then ok=true; fi
  post_digest="$(jq -r '[.[] | .post_state_digest] | map(select(. != null)) | last // empty' "${campaign_passes}")"
  jq -cn \
    --argjson ok "${ok}" \
    --arg reason "${reason}" \
    --slurpfile passes "${campaign_passes}" \
    --argjson max_passes "${run_max_passes}" \
    --argjson deadline_ms "${run_deadline_ms}" \
    --arg post_digest "${post_digest}" \
    '($passes[0] // []) as $passes |
     {ok: $ok, reason: (if ($reason | length) == 0 then null else $reason end),
      passes: ($passes | length), max_passes: $max_passes, deadline_ms: $deadline_ms,
      deleted_objects_total: ([$passes[].deleted_objects] | add // 0),
      deleted_bytes_total: ([$passes[].deleted_bytes] | add // 0),
      verified_deleted_objects_total: ([$passes[].verified_deleted_objects] | add // 0),
      verified_deleted_bytes_total: ([$passes[].verified_deleted_bytes] | add // 0),
      post_state_digest: (if ($post_digest | length) == 0 then null else $post_digest end),
      final_report: null,
      campaign: $passes}' > "${campaign_record}"
}

# The exact proof that the backlog is gone: a fresh report whose candidate set
# is empty and whose scanned keyset digest is the one the finished campaign
# proved. Counts alone cannot tell one key from another, so the digest is what
# this compares. Writes final_report_proof_json, never an argument.
final_report_proof() {
  local expected_json report_status report_class reason_text
  expected_json="$(jq -cn --arg digest "${1:-}" 'if ($digest | length) == 0 then null else $digest end')"
  report_status="$(call_gate plan "${final_report_response}")"
  report_class="$(classify_gate_response "${report_status}" "${final_report_response}")"
  if [ "${report_class}" != ok ]; then
    reason_text="the final report reached the gate with HTTP ${report_status:-none} (${report_class})"
    jq -cn --arg reason "${reason_text}" --arg status "${report_status}" --arg class "${report_class}" \
      '{ok: false, reason: $reason, http_status: ($status | tonumber? // null), gate_class: $class}' \
      > "${final_report_proof_json}"
    return 0
  fi
  jq -cn \
    --argjson expected "${expected_json}" \
    --argjson cap "${max_evidence_keys}" \
    --arg unknown fault \
    --slurpfile envelope "${final_report_response}" \
    '($envelope[0] // {}) as $outer |
     ($outer.result // $outer) as $report |
     ($report.plan // null) as $plan |
     ($plan.details // {}) as $details |
     ($details.keysets // {}) as $keysets |
     (($details.faults // null) | if type == "array" then length else null end) as $faults |
     {ok: (
        (($plan | type) == "object") and
        ($plan.truncated == false) and
        ($details.deleteAllowedByReferences == true) and
        ($faults == 0) and
        (($details.candidateTotal // null) == 0) and
        (($keysets.candidates.objects // null) == 0) and
        ($expected != null) and
        (($keysets.scanned.digest // null) == $expected)
      ),
      status: ($report.status // null),
      truncated: (if ($plan | type) == "object" and ($plan | has("truncated")) then $plan.truncated else null end),
      delete_allowed_by_references:
        (if ($details | type) == "object" and ($details | has("deleteAllowedByReferences")) then $details.deleteAllowedByReferences else null end),
      faults: $faults,
      fault_codes: [(($details.faults // [])[]) | (.code? // $unknown)],
      candidate_total: ($details.candidateTotal // null),
      candidate_objects: (($plan.candidateObjects // []) | length),
      candidate_sample: (($plan.candidateObjects // [])[0:$cap]),
      candidate_sample_truncated: ((($plan.candidateObjects // []) | length) > $cap),
      scanned_objects: ($plan.objectsScanned // null),
      retained_objects: ($plan.retainedObjects // null),
      keysets: {scanned: ($keysets.scanned // null), retained: ($keysets.retained // null), candidates: ($keysets.candidates // null)},
      expected_scanned_digest: $expected,
      post_digest_match: (($keysets.scanned.digest // null) == $expected)}' \
    > "${final_report_proof_json}"
}

# Live state selects the transport. A collector that does not exist can not
# delete during a migration, so a first rollout skips the gate instead of
# calling an endpoint that the serving parent does not publish yet. Only a
# confirmed 404 counts as absent; an unreadable probe stops the deployment.
bash "${repository_root}/tools/deploy/registry-cleanup-state.sh" \
  "${state}" "${deployment}" "${version}" || {
  echo 'the registry cleanup state probe failed, so the gate can not decide.' >&2
  exit 1
}
# `jq -e` exits 1 on a false value, so the boolean is read without -e.
child_present="$(jq -r '.script_present | tostring' "${state}")"
test "${child_present}" = true || test "${child_present}" = false || {
  echo 'the registry cleanup state probe returned no script_present flag' >&2
  exit 1
}
live_mode="$(jq -er '.mode' "${state}")"
active_version_id="$(jq -r '.active_version_id // ""' "${state}")"

gate_class="skipped"
gate_code=""
http_status=""
paused=null
idle=null
skipped_reason=""
inventory_json="null"
admission_json="null"
# The campaign record starts as null in its own file, and every later state of
# it is written there as well: the record carries the pass key lists, which are
# far larger than an argument may be.
preview_json="null"
preview_problem=""

if [ "${child_present}" = false ]; then
  skipped_reason="no_collector_version"
else
  test -n "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET:-}" || {
    echo "the deployment gate needs CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET" >&2
    exit 1
  }

  if [ "${action}" = hold ]; then
    # The D1 upload admission state is the one authority for whether an
    # uploader can race the collector. The collector reads it from the shared
    # database, so this answer is the same one the child asserts before it
    # deletes. It is recorded for every hold; it is enforced for delete mode
    # only, because a report-only collector never deletes.
    take_admission_proof
    # Delete authority needs the D1 admission switch, not a mode string and not
    # any unrelated rollout variable. The child asserts the same state again
    # inside its own run, so this is the earliest honest refusal.
    if [ "${target_mode}" = delete ]; then
      if [ "${admission_problem}" != ok ]; then
        echo "delete mode needs the D1 admission state, but ${admission_problem}." >&2
        echo 'That state is image_registry_admission.enforcement, which the collector reads from the shared database.' >&2
        exit 1
      fi
      take_inventory_proof
      if [ "${inventory_problem}" != ok ]; then
        echo "the delete mode needs a completed, fault-free report inventory, but ${inventory_problem}." >&2
        echo 'A truncated listing or a retention fault means the delete set is unproven, so deletes stay off.' >&2
        exit 1
      fi
    fi
  fi

  if [ "${action}" = run ]; then
    # A report-only collector never deletes: a run against it would list the
    # delete set again and finish with nothing done, so it is refused as a
    # caller error instead of being reported as a finished campaign.
    if [ "${live_mode}" != delete ]; then
      run_refusal "the serving collector mode is ${live_mode}, and a run would not delete" \
        > "${campaign_record}"
    else
      # The delete authority is proven here, from the serving parent, right
      # before the first delete. A reopen cannot reuse the hold evidence of
      # the cutover that closed the plane: its runner is fresh, so the
      # campaign takes the same proof itself.
      take_admission_proof
      if [ "${admission_problem}" != ok ]; then
        run_refusal "the delete campaign needs the D1 admission state, but ${admission_problem}." \
          > "${campaign_record}"
      else
        take_inventory_proof
        if [ "${inventory_problem}" != ok ]; then
          run_refusal "the delete campaign needs a completed, fault-free report inventory, but ${inventory_problem}." \
            > "${campaign_record}"
        else
          run_cleanup_to_completion
          if [ "$(jq -r '.ok' "${campaign_record}")" = true ]; then
            final_report_proof "$(jq -r '.post_state_digest // empty' "${campaign_record}")"
            # The jq program is single-quoted on purpose; $run[0] is a jq
            # array subscript, not a shell expansion.
            # shellcheck disable=SC2016
            replace_campaign_record \
              '$run[0] + {final_report: $final[0], ok: ($run[0].ok and $final[0].ok)}' \
              --slurpfile run "${campaign_record}" --slurpfile final "${final_report_proof_json}"
          fi
          # The preflight summaries are counts and short codes, so they stay
          # small enough to travel as values.
          # shellcheck disable=SC2016
          replace_campaign_record \
            '$run[0] + {preflight: {admission: $admission, inventory: $inventory}}' \
            --slurpfile run "${campaign_record}" \
            --argjson admission "${admission_json}" \
            --argjson inventory "${inventory_json}"
        fi
      fi
    fi
    gate_class=campaign
  elif [ "${action}" = release ]; then
    http_status="$(call_gate resume "${response}")"
  elif [ "${action}" = plan ]; then
    http_status="$(call_gate plan "${response}")"
  else
    http_status="$(call_gate pause "${response}" "$(jq -cn --argjson waitMs "${wait_ms}" '{wait_ms: $waitMs}')")"
  fi
  # The campaign classifies its own calls, so it has no single response to
  # classify here.
  if [ "${action}" != run ]; then
  gate_class="$(classify_gate_response "${http_status}" "${response}")"
  gate_code="$(jq -r '.code // ""' "${response}" 2>/dev/null || true)"
  # A plan is a read, so its refusal is reported through the evidence instead of
  # ending the step before the evidence is written: the preview names what
  # answered, and the caller still gets the raw body.
  if [ "${action}" != plan ]; then
    case "${gate_class}" in
      ok) ;;
      unavailable) ;;
      *)
        explain_fatal_gate_class "${gate_class}" "${http_status}" "${response}"
        exit 1
        ;;
    esac
  fi
  if [ "${gate_class}" = ok ]; then
    # An unreadable collector answer stays unreadable: both the hold and the
    # release fail closed on a missing flag. A missing flag is null, never
    # false. The controller answers {action, result:{...}}, and jq `//` treats
    # false as absent, so `.result.paused // .paused` would turn a nested false
    # into null; the envelope is normalised once and the field is read from it.
    paused="$(jq -r '
      ((.result // .) | .paused) |
      if . == true then true elif . == false then false else null end
    ' "${response}")"
    idle="$(jq -r '
      ((.result // .) | .idle) |
      if . == true then true elif . == false then false else null end
    ' "${response}")"
  fi
  if [ "${action}" = plan ]; then
    # The preview is the report-only proof that the child binding works before
    # a delete release: the collector read the maintenance flag from the parent
    # that serves traffic and that parent is open, and the plan it produced is
    # complete and fault free. A child whose CONTROL_PLANE binding is missing
    # reports maintenanceSource "unavailable" and fences itself, so a reachable
    # gate alone is not that proof. The envelope is already in hand, so this is
    # one call and one bucket scan.
    if [ "${gate_class}" = ok ]; then
      evaluate_plan_file "${response}"
    else
      mark_inventory_unreadable "${http_status}" "${gate_class}"
    fi
    preview_json="$(jq -cn \
      --argjson inventory "${inventory_json}" \
      --slurpfile envelope "${response}" \
      '($envelope[0] // {}) as $outer |
       ($outer.result // $outer) as $report |
       {
         maintenance: ($report.maintenance // null),
         maintenance_source: ($report.maintenanceSource // null),
         status: ($report.status // null),
         mode: ($report.mode // null),
         plan_mode: (($report.plan // null) | if type == "object" then .mode else null end),
         maintenance_off: (($report.maintenance // null) == "off"),
         maintenance_source_control_plane: (($report.maintenanceSource // null) == "control-plane"),
         inventory: $inventory,
         ok: ((($report.maintenance // null) == "off") and
              (($report.maintenanceSource // null) == "control-plane") and
              (($inventory.ok // false) == true))
       }')"
    if [ "$(jq -r '.maintenance_off | tostring' <<<"${preview_json}")" != true ]; then
      preview_problem="the serving control plane reports maintenance \"$(jq -r '.maintenance // "unreadable" | tostring' <<<"${preview_json}")\""
    elif [ "$(jq -r '.maintenance_source_control_plane | tostring' <<<"${preview_json}")" != true ]; then
      preview_problem="the collector read the maintenance flag from \"$(jq -r '.maintenance_source // "nothing" | tostring' <<<"${preview_json}")\", not from the control plane"
    elif [ "${inventory_problem}" != ok ]; then
      preview_problem="${inventory_problem}"
    fi
    preview_json="$(jq -c --arg problem "${preview_problem}" \
      '. + {problem: (if ($problem | length) == 0 then null else $problem end)}' \
      <<<"${preview_json}")"
  fi
  fi
fi

# The hold is a row in the shared admission gate and does not expire. A release
# that can not reach the gate therefore reads the hold this rollout recorded, or
# it reports the possible leftover instead of claiming a clean release.
hold_leave="none"
if [ "${action}" = release ] && [ -f "${hold_evidence}" ]; then
  hold_leave="$(jq -r '
    ((.result // .) | .paused) |
    if . == true then "left" elif . == false then "none" else "unknown" end
  ' "${hold_evidence}")"
fi

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg action "${action}" \
  --arg worker_name "${worker_name}" \
  --arg url "${gate_url}" \
  --arg origin "${gate_origin}" \
  --arg gate "${gate_class}" \
  --arg gate_code "${gate_code}" \
  --arg live_mode "${live_mode}" \
  --arg target_mode "${target_mode}" \
  --arg http_status "${http_status}" \
  --arg skipped_reason "${skipped_reason}" \
  --arg hold_leave "${hold_leave}" \
  --arg active_version_id "${active_version_id}" \
  --argjson paused "${paused}" \
  --argjson idle "${idle}" \
  --argjson child_present "${child_present}" \
  --argjson inventory "${inventory_json}" \
  --argjson admission "${admission_json}" \
  --slurpfile run "${campaign_record}" \
  --argjson preview "${preview_json}" \
  --slurpfile response "${response}" \
  --slurpfile deployment "${deployment}" \
  --slurpfile probe "${state}" \
  --slurpfile plan "${plan_response}" \
  --slurpfile status "${status_response}" \
  '{
    schema_version: 1,
    operation: "registry-cleanup-gate",
    source_sha: $source_sha,
    action: $action,
    worker_name: $worker_name,
    url: $url,
    origin: $origin,
    gate: $gate,
    gate_code: (if $gate_code == "" then null else $gate_code end),
    live_mode: $live_mode,
    target_mode: $target_mode,
    http_status: $http_status,
    child_present: $child_present,
    active_version_id: (if $active_version_id == "" then null else $active_version_id end),
    skipped_reason: (if $skipped_reason == "" then null else $skipped_reason end),
    hold_leave: $hold_leave,
    inventory: $inventory,
    admission: $admission,
    run: ($run[0] // null),
    preview: $preview,
    paused: $paused,
    idle: $idle,
    enforced: ($gate == "ok"),
    response: (if ($response | length) == 0 then null else $response[0] end),
    deployment: (if ($deployment | length) == 0 then null else $deployment[0] end),
    plan_response: (if ($plan | length) == 0 then null else $plan[0] end),
    status_response: (if ($status | length) == 0 then null else $status[0] end),
    probe: $probe[0]
  }' > "${evidence}"

# The response evidence is uploaded as an artifact, so it must never carry the
# machine credential that authorized the calls. A reflected secret fails the
# step, and every offending file, the evidence included, is removed first.
require_clean_evidence

if [ "${action}" = run ]; then
  if [ "${child_present}" = false ]; then
    echo 'no registry cleanup version is deployed; there is nothing to run.'
    exit 0
  fi
  if jq -e '.run.ok == true' "${evidence}" >/dev/null; then
    echo "the cleanup campaign finished: $(jq -c '.run | {passes, deleted_objects_total, verified_deleted_objects_total, final_report: {candidate_total: .final_report.candidate_total, post_digest_match: .final_report.post_digest_match}}' "${evidence}")"
    exit 0
  fi
  echo 'the cleanup campaign did not finish.' >&2
  jq -c '.run | {ok, reason, passes, final_report: (.final_report // null)}' "${evidence}" >&2
  exit 1
fi

if [ "${action}" = hold ]; then
  if [ "${gate_class}" = skipped ]; then
    # No collector version is deployed, so nothing can delete during the
    # migration. The first rollout takes this path.
    echo 'no registry cleanup version is deployed; the migration runs without a hold.'
    exit 0
  fi
  if [ "${gate_class}" = unavailable ]; then
    if [ "${live_mode}" = delete ] || [ "${target_mode}" = delete ]; then
      echo 'the deployed registry cleanup worker can delete, but the deployment gate is unavailable.' >&2
      echo 'A delete-capable collector must be held before a D1 migration.' >&2
      exit 1
    fi
    echo 'the registry cleanup worker is report-only and the deployment gate is absent.'
    exit 0
  fi
  jq -e '.paused == true and .idle == true' "${evidence}" >/dev/null
  exit 0
fi

if [ "${gate_class}" = skipped ]; then
  if [ "${action}" = plan ]; then
    echo 'no registry cleanup version is deployed; there is no report to read.' >&2
    exit 1
  fi
  echo 'no registry cleanup version is deployed; there is no hold to release.'
  exit 0
fi
if [ "${gate_class}" = unavailable ]; then
  if [ "${action}" = plan ]; then
    echo 'the deployment gate is unavailable, so the collector can not be reached through the parent.' >&2
    exit 1
  fi
  # A hold does not expire, so an unreachable gate is only clean when this
  # rollout never placed one.
  if [ "${hold_leave}" = left ]; then
    echo 'this rollout holds the registry cleanup worker, but the deployment gate is unreachable.' >&2
    echo 'Release it through the maintenance surface before the control plane reopens.' >&2
    exit 1
  fi
  echo 'the deployment gate is absent and this rollout placed no hold.'
  exit 0
fi

# The preview is a requirement, not a report: the collector must have answered
# a complete, fault-free plan while reading an open maintenance flag from the
# parent that serves traffic. Anything else fails the step, and the evidence
# names what answered.
if [ "${action}" = plan ]; then
  if [ "${gate_class}" != ok ]; then
    explain_fatal_gate_class "${gate_class}" "${http_status}" "${response}"
  fi
  if jq -e '.preview.ok == true' "${evidence}" >/dev/null; then
    echo "the report preview is clean: $(jq -c '.preview | {maintenance, maintenance_source, status, mode, scanned_objects, candidates_total}' "${evidence}")"
    exit 0
  fi
  echo 'the report preview did not prove a healthy report-only collector.' >&2
  jq -c '.preview | {maintenance, maintenance_source, status, mode, problem, fault_codes: .inventory.fault_codes, truncated: .inventory.truncated}' "${evidence}" >&2
  exit 1
fi

jq -e '.paused == false' "${evidence}" >/dev/null
