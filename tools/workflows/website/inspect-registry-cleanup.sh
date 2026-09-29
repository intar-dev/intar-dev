#!/usr/bin/env bash
# Website workflow, deploy job, step "Inspect the image registry cleanup deployment".
set -euo pipefail
# The rollout order depends on live state, not on an assumption. A
# first rollout has no collector, so the parent deploy must omit the
# REGISTRY_CLEANUP binding; a binding to a service that does not exist
# yet fails the deploy. A later rollout has one, and the binding
# resolves.
state="${RUNNER_TEMP}/registry-cleanup-state.json"
# Only a confirmed 404 counts as no collector. An expired token, a
# forbidden account, or a network failure is indeterminate, and this
# step must not read it as a first rollout that skips the hold.
tools/deploy/registry-cleanup-state.sh "${state}" \
  "${RUNNER_TEMP}/registry-cleanup-active-deployment.json" \
  "${RUNNER_TEMP}/registry-cleanup-active-version.json"
child_present="$(jq -r '.script_present | tostring' "${state}")"
live_mode="$(jq -er '.mode' "${state}")"
mode_proven="$(jq -r '.mode_proven | tostring' "${state}")"
# The mode is a release decision, so it is resolved once, here, and
# the later steps read the answer instead of the raw input. Preserve
# keeps what a deployed collector already proves, and it never
# downgrades a delete-capable collector because a lane ran with the
# default input.
case "${REGISTRY_CLEANUP_INTENT}" in
  preserve)
    if [ "${child_present}" = false ]; then
      resolved="report-only"
    elif [ "${mode_proven}" != true ]; then
      echo 'Cannot preserve the cleanup mode: the active version does not prove its mode.' >&2
      exit 1
    else
      resolved="${live_mode}"
    fi
    ;;
  report-only|delete)
    resolved="${REGISTRY_CLEANUP_INTENT}"
    ;;
  *)
    echo "registry_cleanup_mode must be preserve, report-only, or delete" >&2
    exit 1
    ;;
esac
jq -n \
  --arg intent "${REGISTRY_CLEANUP_INTENT}" \
  --arg resolved "${resolved}" \
  --arg live_mode "${live_mode}" \
  --argjson child_present "${child_present}" \
  --argjson mode_proven "${mode_proven}" \
  --slurpfile probe "${state}" \
  '{
    schema_version: 1,
    operation: "registry-cleanup-mode",
    intent: $intent,
    resolved_mode: $resolved,
    live_mode: $live_mode,
    child_present: $child_present,
    live_mode_proven: $mode_proven,
    probe: $probe[0]
  }' > "${RUNNER_TEMP}/registry-cleanup-mode.json"
{
  printf 'child_present=%s\n' "${child_present}"
  printf 'resolved_mode=%s\n' "${resolved}"
  printf 'REGISTRY_CLEANUP_MODE=%s\n' "${resolved}"
} >> "${GITHUB_OUTPUT}"
printf 'REGISTRY_CLEANUP_MODE=%s\n' "${resolved}" >> "${GITHUB_ENV}"
printf 'registry cleanup worker present: %s; intent: %s; resolved mode: %s; live mode: %s\n' \
  "${child_present}" "${REGISTRY_CLEANUP_INTENT}" "${resolved}" "${live_mode}" \
  >> "${GITHUB_STEP_SUMMARY}"
