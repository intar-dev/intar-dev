#!/usr/bin/env bash
# Activate the D1 upload admission switch for a delete-mode release.
#
#   usage: tools/deploy/registry-cleanup-activation.sh <enforce|report_only> <evidence.json>
#
# This is the explicit prerequisite of a delete-mode rollout: the builder host
# must already run the verified session-aware uploader, and the operator then
# chooses delete mode, which turns the switch on. It calls the API the control
# plane already publishes, so no manual D1 SQL and no new workflow is needed.
#
# It never runs on its own. Nothing here is called for the default mode
# (preserve), so an emergency D1 disable stays in force until an operator asks
# for delete mode on purpose. It also reads no learner-run CLI rollout
# variable: that switch belongs to a different feature and has nothing to do
# with registry admission.
#
# It runs before maintenance closes, because the registry API sits behind the
# maintenance fence. A reopen never calls it: the cutover that preceded the
# reopen already activated the switch, and the request would be fenced.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: tools/deploy/registry-cleanup-activation.sh <enforce|report_only> <evidence.json>" >&2
  exit 64
fi

readonly mode="$1"
readonly evidence="$2"
readonly activation_url="${REGISTRY_ENFORCEMENT_URL:-https://intar.dev/registry/v1/admission/enforcement}"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-registry-cleanup-activation-${GITHUB_RUN_ID:-local}"
readonly response="${runtime_root}/response.json"

# Every file this step writes is uploaded as deployment evidence, even when
# the step fails, so no file may carry the credential. Any file that does is
# destroyed, and the exit trap makes that true for every exit path, including
# an abort from `set -e`. Deleting is deliberate: a sanitized file would still
# describe a run whose bytes can no longer be trusted.
scrub_secret_files() {
  local secret="${REGISTRY_PUBLISH_TOKEN:-}"
  local removed=0 candidate
  if [ -z "${secret}" ]; then
    return 0
  fi
  for candidate in "${evidence}" "${response}" "${runtime_root}"/*; do
    [ -f "${candidate}" ] || continue
    if grep -qF -- "${secret}" "${candidate}" 2>/dev/null; then
      rm -f -- "${candidate}"
      echo "removed a file that reflected the registry credential: ${candidate}" >&2
      removed=1
    fi
  done
  if [ "${removed}" = 1 ]; then
    return 1
  fi
  return 0
}

on_exit_scrub() {
  local status=$?
  if ! scrub_secret_files; then
    echo 'the activation step removed files that reflected the registry credential before it exited.' >&2
    exit 1
  fi
  exit "${status}"
}
trap on_exit_scrub EXIT

mkdir -p "${runtime_root}"
# The publish token travels in a header, never in a file: the deploy lane
# uploads this directory as deployment evidence.
chmod 700 "${runtime_root}"
touch "${response}"
test ! -e "${evidence}"
test -n "${GITHUB_SHA:-}"

case "${mode}" in
  enforce|report_only) ;;
  *)
    echo "mode must be enforce or report_only" >&2
    exit 1
    ;;
esac
test -n "${REGISTRY_PUBLISH_TOKEN:-}" || {
  echo "the activation step needs REGISTRY_PUBLISH_TOKEN" >&2
  exit 1
}

# curl receives the token as an argument of this one call, so the token is
# visible in this runner's process list while curl runs. It never reaches a
# file, and anything an answer reflects back is destroyed before this step
# exits.
request_body="$(jq -cn --arg mode "${mode}" '{mode: $mode}')"
http_status="$(printf '%s' "${request_body}" | curl --silent --show-error --max-time 60 \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${REGISTRY_PUBLISH_TOKEN}" \
  --data-binary "@-" \
  --output "${response}" --write-out '%{http_code}' \
  "${activation_url}" || true)"
unset request_body

# The response is read from the shared database after the write, so it is the
# D1 state and not an echo of the request. A mismatch fails the step: a delete
# release must not proceed on an unproven switch.
problem="$(jq -r --arg mode "${mode}" '
  if (.ok // false) != true then "the response carries no ok flag"
  elif (.enforcement // "") != $mode then "the D1 enforcement state is \"" + (.enforcement | tostring) + "\" after the write"
  # `//` reads a boolean false as absent, so the flag is checked for presence
  # and for its type instead. A report_only disable answers session_required
  # false, and that answer must pass.
  elif ((has("session_required") | not) or ((.session_required | type) != "boolean")) then "the response carries no session_required flag"
  elif (($mode == "enforce") and (.session_required != true)) then "session_required is false while enforcement is enforce"
  elif (($mode == "report_only") and (.session_required != false)) then "session_required is true while enforcement is report_only"
  else "" end' "${response}" 2>/dev/null || echo 'the response body could not be read')"
if [ "${http_status}" != 200 ]; then
  problem="the activation endpoint answered HTTP ${http_status:-none}"
fi

# A body that does not parse must not stop the evidence from being written, so
# it is normalised to null and the failure is reported through the problem.
response_json="$(jq -c . "${response}" 2>/dev/null || printf 'null')"
readonly response_json

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID:-local}" \
  --arg url "${activation_url}" \
  --arg mode "${mode}" \
  --arg http_status "${http_status}" \
  --arg problem "${problem}" \
  --argjson response "${response_json}" \
  '{
    schema_version: 1,
    operation: "registry-cleanup-activation",
    source_sha: $source_sha,
    run_id: $run_id,
    url: $url,
    requested_mode: $mode,
    http_status: $http_status,
    ok: (($problem | length) == 0),
    problem: (if ($problem | length) == 0 then null else $problem end),
    response: $response
  }' > "${evidence}"

# The token authorized this call, and the evidence is an uploaded artifact, so
# an answer that reflected the token fails the step after every offending file,
# the evidence included, is removed.
if ! scrub_secret_files; then
  echo 'the activation step removed files that reflected the registry credential.' >&2
  exit 1
fi

if [ -n "${problem}" ]; then
  echo "the activation step failed: ${problem}" >&2
  echo 'The builder host must already run the verified session-aware uploader before delete mode is chosen.' >&2
  exit 1
fi

echo "registry cleanup activation: enforcement is ${mode} in the shared database."
