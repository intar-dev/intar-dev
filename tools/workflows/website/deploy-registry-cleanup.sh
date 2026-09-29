#!/usr/bin/env bash
# Website workflow, deploy job, step "Deploy the image registry cleanup worker".
set -euo pipefail
# Astro builds this auxiliary worker next to the parent configuration,
# and the tested artifact carries both. The parent deploy above is the
# first half of the rollout: the collector reads the live maintenance
# flag from the version that serves traffic, and the parent binding to
# the collector becomes usable only once this step has run.
case "${REGISTRY_CLEANUP_MODE}" in
  report-only|delete) ;;
  *) echo "the resolved registry cleanup mode must be report-only or delete" >&2; exit 1 ;;
esac
cleanup_config="${GITHUB_WORKSPACE}/apps/web/dist/intar_dev_image_registry_cleanup/wrangler.json"
test -f "${cleanup_config}"
bucket_name="$(jq -er '
  [.r2_buckets[] | select(.binding == "VM_IMAGE_REGISTRY_BUCKET")] |
  select(length == 1) | .[0].bucket_name
' "${DEPLOYMENT_CONFIG}")"
# The tested artifact pins report-only. Delete mode is a deployment
# decision, so this lane derives its own configuration from the tested
# one, exactly as the maintenance deploy does, and deploys that.
cleanup_deploy_config="$(dirname "${cleanup_config}")/wrangler-${REGISTRY_CLEANUP_MODE}.json"
test ! -e "${cleanup_deploy_config}"
jq --arg mode "${REGISTRY_CLEANUP_MODE}" \
  '.vars.REGISTRY_CLEANUP_MODE = $mode' \
  "${cleanup_config}" > "${cleanup_deploy_config}"
jq -e --arg mode "${REGISTRY_CLEANUP_MODE}" \
  '.vars.REGISTRY_CLEANUP_MODE == $mode' \
  "${cleanup_deploy_config}" >/dev/null
tools/deploy/deploy-registry-cleanup.sh \
  "${cleanup_deploy_config}" \
  "${DATABASE_ID}" \
  "${bucket_name}" \
  "${REGISTRY_CLEANUP_MODE}" \
  "${RUNNER_TEMP}/registry-cleanup-deploy.json"
