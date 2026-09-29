#!/usr/bin/env bash
# Website workflow, validate job, step "Verify the image registry cleanup worker artifact".
set -euo pipefail
# The site build emits an auxiliary worker for the image registry
# cleanup. The deploy lane deploys the built configuration out of this
# artifact, so this lane proves the listing and the private surface
# before the artifact is uploaded as the tested release.
deploy_config="${GITHUB_WORKSPACE}/apps/web/.wrangler/deploy/config.json"
test -f "${deploy_config}"
expected_relative="../../dist/intar_dev_image_registry_cleanup/wrangler.json"
listed="$(cd "${GITHUB_WORKSPACE}/apps/web" && jq -er \
  --arg expected "${expected_relative}" '
    [.auxiliaryWorkers[].configPath | select(. == $expected)] |
    select(length == 1) | .[0]
  ' .wrangler/deploy/config.json)"
# A configPath resolves against the directory that holds the file
# naming it, which is .wrangler/deploy, not the project root. The
# listing already pins the relative form above.
cleanup_config="${GITHUB_WORKSPACE}/apps/web/.wrangler/deploy/${listed}"
test -f "${cleanup_config}"
jq -e '
  (.name == "intar-dev-image-registry-cleanup") and
  (.triggers.crons == ["17 */6 * * *"]) and
  (.vars.REGISTRY_CLEANUP_MODE == "report-only") and
  (((.routes // []) | length) == 0) and
  ((.workers_dev // false) == false) and
  ((.preview_urls // false) == false) and
  (.assets == null) and
  ((((.migrations // []) | length) == 0)) and
  ((((.durable_objects.bindings // []) | length) == 0)) and
  (([.d1_databases[]? | select(.binding == "DB")] | length) == 1) and
  (([.r2_buckets[]? | select(.binding == "VM_IMAGE_REGISTRY_BUCKET")] | length) == 1) and
  (([.services[]? | select(.binding == "CONTROL_PLANE" and .entrypoint == "MaintenanceState")] | length) == 1)
' "${cleanup_config}" >/dev/null
printf 'auxiliary worker config: %s\n' "${cleanup_config}" \
  >> "${GITHUB_STEP_SUMMARY}"
