#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Hold the image registry collector".
set -euo pipefail
case "${REGISTRY_CLEANUP_MODE}" in
  report-only|delete) ;;
  *) echo "REGISTRY_CLEANUP_MODE must be report-only or delete" >&2; exit 1 ;;
esac
evidence="${RUNNER_TEMP}/registry-cleanup-hold.json"
# Without a pending migration nothing changes D1 under the collector, so the
# gate's keep places no hold when the collector keeps its mode. It exits 3 when
# it can not prove that, and the deploy takes the full hold below.
if [ "${MIGRATIONS_PENDING:-true}" != true ]; then
  status=0
  tools/deploy/registry-cleanup-gate.sh keep "${REGISTRY_CLEANUP_MODE}" "${evidence}" || status=$?
  [ "${status}" = 3 ] || exit "${status}"
fi
# The mode is the one the tested artifact carries, pinned by the
# production configuration step. The hold writes the shared admission
# row, so it stops a sweep of any isolate and refuses the next upload
# session. A collector that deletes must be held and idle before the
# migration touches D1, and it stays held until this run releases it.
# Behind the lane's own maintenance version, which a failed migration
# deploy leaves serving, the hold proves an idle collector and D1
# admission from the shared admission row instead.
tools/deploy/registry-cleanup-gate.sh hold "${REGISTRY_CLEANUP_MODE}" "${evidence}"
