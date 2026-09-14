#!/usr/bin/env bash
# Decide whether this rollout must redeploy the image registry cleanup worker.
#
#   usage: tools/deploy/registry-cleanup-child-gate.sh <cutover|reopen> <mode> <sha12> <evidence.json>
#
# Prints two GITHUB_OUTPUT lines on stdout: skip=true|false and reason=... .
#
# Why this gate exists: the child deploy in delete mode requires the hold
# evidence, which only the step before maintenance closes can take. The reopen
# operation runs with the control plane already closed and in a fresh runner,
# so it must not need that evidence. It does not need it when the collector
# that serves is already the exact build this artifact would deploy: the same
# source revision and the same mode, proven from the Cloudflare version. Then
# the reopen only reopens the parent, releases the collector, and runs the
# delete campaign, which takes its own admission and inventory proof from the
# open parent before the first delete.
#
# A reopen that would have to replace the collector is refused instead of
# deadlocking on evidence it can never have: replacing a delete-capable
# collector needs the inventory, and the inventory needs a serving control
# plane. The cutover operation holds and inventories before it closes, so the
# operator runs that one.
#
# A first rollout is never skipped: no collector version answers, so the child
# deploy runs, and its hold evidence was taken by the hold step.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: tools/deploy/registry-cleanup-child-gate.sh <cutover|reopen> <mode> <sha12> <evidence.json>" >&2
  exit 64
fi

readonly operation="$1"
readonly mode="$2"
readonly source_tag_suffix="$3"
readonly evidence="$4"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-registry-cleanup-child-${GITHUB_RUN_ID:-local}"
readonly state="${runtime_root}/state.json"
readonly deployment="${runtime_root}/deployment.json"
readonly version="${runtime_root}/version.json"

mkdir -p "${runtime_root}"
test ! -e "${evidence}"

case "${operation}" in
  cutover|reopen) ;;
  *)
    echo "operation must be cutover or reopen" >&2
    exit 1
    ;;
esac
case "${mode}" in
  report-only|delete) ;;
  *)
    echo "mode must be report-only or delete" >&2
    exit 1
    ;;
esac
test -n "${source_tag_suffix}" || {
  echo "the gate needs the source revision prefix for the deploy tag" >&2
  exit 1
}

bash "${repository_root}/tools/deploy/registry-cleanup-state.sh" \
  "${state}" "${deployment}" "${version}" || {
  echo 'the registry cleanup state probe failed, so the child gate can not decide.' >&2
  exit 1
}

script_present="$(jq -r '.script_present | tostring' "${state}")"
live_mode="$(jq -er '.mode' "${state}")"
mode_proven="$(jq -r '.mode_proven | tostring' "${state}")"
live_tag="$(jq -r '.tag // ""' "${state}")"
active_version_id="$(jq -r '.active_version_id // ""' "${state}")"
expected_tag="cleanup-${source_tag_suffix}-${mode}"

skip=false
reason=""

if [ "${script_present}" != true ]; then
  reason="no_collector_version"
elif [ "${mode_proven}" != true ]; then
  reason="live_mode_unproven"
elif [ "${live_mode}" != "${mode}" ]; then
  reason="live_mode_differs"
elif [ "${live_tag}" != "${expected_tag}" ]; then
  reason="source_differs"
else
  skip=true
  reason="same_source_and_mode"
fi

jq -n \
  --arg operation "${operation}" \
  --arg mode "${mode}" \
  --arg live_mode "${live_mode}" \
  --arg expected_tag "${expected_tag}" \
  --arg live_tag "${live_tag}" \
  --arg active_version_id "${active_version_id}" \
  --arg reason "${reason}" \
  --argjson script_present "${script_present}" \
  --argjson mode_proven "${mode_proven}" \
  --argjson skip "${skip}" \
  --slurpfile probe "${state}" \
  '{
    schema_version: 1,
    operation: "registry-cleanup-child-gate",
    worker_name: "intar-dev-image-registry-cleanup",
    request: {operation: $operation, mode: $mode},
    skip: $skip,
    reason: $reason,
    script_present: $script_present,
    live_mode: $live_mode,
    live_mode_proven: $mode_proven,
    live_tag: (if $live_tag == "" then null else $live_tag end),
    expected_tag: $expected_tag,
    active_version_id: (if $active_version_id == "" then null else $active_version_id end),
    probe: $probe[0]
  }' > "${evidence}"

if [ "${operation}" = reopen ] && [ "${mode}" = delete ] && [ "${skip}" != true ]; then
  echo "a reopen can not replace the delete-capable registry cleanup worker (${reason})." >&2
  echo 'Replacing it needs the inventory and the D1 admission proof, and both need a serving control plane.' >&2
  echo 'Run the Website cutover operation for this revision with registry_cleanup_mode delete, or reopen with preserve while delete mode already serves.' >&2
  echo "expected_tag=${expected_tag} live_tag=${live_tag:-none} live_mode=${live_mode}" >&2
  exit 1
fi

printf 'skip=%s\n' "${skip}"
printf 'reason=%s\n' "${reason}"
printf 'registry cleanup child gate: %s (operation=%s mode=%s live_mode=%s live_tag=%s)\n' \
  "${reason}" "${operation}" "${mode}" "${live_mode}" "${live_tag:-none}" \
  >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
