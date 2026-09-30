#!/usr/bin/env bash
# Website workflow, deploy job, step "Deploy the image registry cleanup worker".
set -euo pipefail
# Astro builds this auxiliary worker next to the parent configuration,
# and the tested artifact carries both. The collector reads the live
# maintenance flag from the parent version that serves traffic, and
# the parent binding to the collector resolves once this step has run.
# The artifact's configuration is deployed as built: its
# REGISTRY_CLEANUP_MODE, pinned by the production configuration step,
# is the mode this release runs.
cleanup_config="${GITHUB_WORKSPACE}/apps/web/dist/intar_dev_image_registry_cleanup/wrangler.json"
test -f "${cleanup_config}"
bucket_name="$(jq -er '
  [.r2_buckets[] | select(.binding == "VM_IMAGE_REGISTRY_BUCKET")] |
  select(length == 1) | .[0].bucket_name
' "${DEPLOYMENT_CONFIG}")"
tools/deploy/deploy-registry-cleanup.sh \
  "${cleanup_config}" \
  "${DATABASE_ID}" \
  "${bucket_name}" \
  "${REGISTRY_CLEANUP_MODE}" \
  "${RUNNER_TEMP}/registry-cleanup-deploy.json"
