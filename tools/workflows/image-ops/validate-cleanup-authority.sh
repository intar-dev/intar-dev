#!/usr/bin/env bash
# image-ops workflow, cleanup job, "Validate cleanup authority" step.
set -euo pipefail
test "${GITHUB_REF}" = refs/heads/main
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
case "${ACTION}" in
  status|plan|run|resolve) ;;
  *) echo "action must be status, plan, run, or resolve" >&2; exit 1 ;;
esac
if [ "${ACTION}" = run ]; then
  if [ "${CONFIRMATION}" != 'RUN IMAGE REGISTRY CLEANUP' ]; then
    echo 'the run action needs the exact confirmation.' >&2
    exit 1
  fi
fi
if [ "${ACTION}" = resolve ]; then
  if [ "${CONFIRMATION}" != 'RESOLVE STALLED IMAGE CLEANUP' ]; then
    echo 'the resolve action needs the exact confirmation.' >&2
    exit 1
  fi
  # The run id reaches SQL as a bound parameter, and it is checked
  # here so a typo stops before any call.
  if ! [[ "${EXPECTED_GC_RUN_ID}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]; then
    echo 'resolve needs expected_gc_run_id as a lowercase UUID.' >&2
    exit 1
  fi
fi
test -n "${CLOUDFLARE_ACCOUNT_ID}"
test -n "${CLOUDFLARE_API_TOKEN}"
test -n "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}"
mkdir -p "${RUNNER_TEMP}/intar-image-registry-cleanup"
