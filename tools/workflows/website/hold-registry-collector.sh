#!/usr/bin/env bash
# Website workflow, deploy job, step "Hold the image registry collector before the migration".
set -euo pipefail
case "${REGISTRY_CLEANUP_MODE}" in
  report-only|delete) ;;
  *) echo "registry_cleanup_mode must be report-only or delete" >&2; exit 1 ;;
esac
# The resolved mode comes from the inspect step, never from the raw
# input: a preserved delete mode must not be downgraded here.
# The hold writes the shared admission row, so it stops a sweep of any
# isolate and refuses the next upload session. A collector that
# deletes must be held and idle before the migration touches D1, and
# it stays held until this run, or the reopen that returns the release
# to service, proves otherwise.
tools/deploy/registry-cleanup-gate.sh hold "${REGISTRY_CLEANUP_MODE}" \
  "${RUNNER_TEMP}/registry-cleanup-hold.json"
