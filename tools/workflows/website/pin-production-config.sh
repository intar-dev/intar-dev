#!/usr/bin/env bash
# Website workflow, deploy job, step "Pin and verify production configuration".
cd apps/web
set -euo pipefail
config="${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler.json"
test -f "${config}"
database_id="$(jq -er '
  [.d1_databases[] | select(.binding == "DB")] |
  select(length == 1) | .[0].database_id
' "${config}")"
[[ "${database_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
jq -e \
  --arg database_id "${database_id}" '
    ([.d1_databases[] | select(.binding == "DB")]) as $databases |
    .name == "intar-dev" and
    .vars.CONTROL_PLANE_MAINTENANCE == "off" and
    ($databases | length) == 1 and
    $databases[0].database_id == $database_id and
    ([.kv_namespaces[]? | select(.binding == "SESSION")] | length) == 0 and
    .assets.directory == "../client" and
    .assets.run_worker_first == ["/api/*"]
  ' "${config}" >/dev/null
test -f "${GITHUB_WORKSPACE}/apps/web/dist/client/favicon.svg"
test -f "${GITHUB_WORKSPACE}/apps/web/dist/client/_headers"
# The image registry cleanup worker is an auxiliary worker of this
# site. Its built configuration travels in the same tested artifact,
# so this lane refuses an artifact that lost it. Its mode is committed
# in its wrangler.jsonc, and this release deploys that mode.
cleanup_config="${GITHUB_WORKSPACE}/apps/web/dist/intar_dev_image_registry_cleanup/wrangler.json"
test -f "${cleanup_config}"
cleanup_mode="$(jq -er '.vars.REGISTRY_CLEANUP_MODE' "${cleanup_config}")"
case "${cleanup_mode}" in
  report-only|delete) ;;
  *) echo "the artifact's REGISTRY_CLEANUP_MODE must be report-only or delete" >&2; exit 1 ;;
esac
jq -e \
  --arg database_id "${database_id}" \
  --arg bucket_name "$(jq -er '
    [.r2_buckets[] | select(.binding == "VM_IMAGE_REGISTRY_BUCKET")] |
    select(length == 1) | .[0].bucket_name
  ' "${config}")" \
  --arg cron "17 */6 * * *" \
  '
    ([.d1_databases[]? | select(.binding == "DB")]) as $databases |
    ([.r2_buckets[]? | select(.binding == "VM_IMAGE_REGISTRY_BUCKET")]) as $buckets |
    (.name == "intar-dev-image-registry-cleanup") and
    (($databases | length) == 1) and
    ($databases[0].database_id == $database_id) and
    (($buckets | length) == 1) and
    ($buckets[0].bucket_name == $bucket_name) and
    ($buckets[0].jurisdiction == "eu") and
    (.triggers.crons == [$cron]) and
    (((.routes // []) | length) == 0) and
    ((.workers_dev // false) == false) and
    ((.preview_urls // false) == false) and
    (.assets == null) and
    ((((.migrations // []) | length) == 0)) and
    ((((.durable_objects.bindings // []) | length) == 0))
  ' "${cleanup_config}" >/dev/null
{
  printf 'DATABASE_ID=%s\n' "${database_id}"
  printf 'DEPLOYMENT_CONFIG=%s\n' "${config}"
  printf 'REGISTRY_CLEANUP_MODE=%s\n' "${cleanup_mode}"
} >> "${GITHUB_ENV}"
