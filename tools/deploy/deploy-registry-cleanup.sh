#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: tools/deploy/deploy-registry-cleanup.sh <wrangler-config> <database-id> <bucket-name> <mode> <evidence.json>" >&2
  exit 64
fi

readonly config="$1"
readonly database_id="$2"
readonly bucket_name="$3"
readonly mode="$4"
readonly evidence="$5"
readonly worker_name="intar-dev-image-registry-cleanup"
readonly parent_worker_name="intar-dev"
readonly parent_entrypoint="MaintenanceState"
readonly parent_binding="REGISTRY_CLEANUP"
readonly registry_binding="VM_IMAGE_REGISTRY_BUCKET"
readonly cron_schedule="17 */6 * * *"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-registry-cleanup-deploy-${GITHUB_RUN_ID:-local}"
readonly before_deployment="${runtime_root}/before-deployment.json"
readonly before_version="${runtime_root}/before-version.json"
readonly parent_deployment="${runtime_root}/parent-deployment.json"
readonly parent_version="${runtime_root}/parent-version.json"
readonly deploy_output="${runtime_root}/wrangler-deploy.ndjson"
readonly deploy_result="${runtime_root}/wrangler-deploy.json"
readonly after_deployment="${runtime_root}/after-deployment.json"
readonly after_version="${runtime_root}/after-version.json"
readonly schedules="${runtime_root}/schedules.json"
readonly subdomain="${runtime_root}/subdomain.json"
readonly before_state="${runtime_root}/before-state.json"

mkdir -p "${runtime_root}"
test -f "${config}"
test ! -e "${evidence}"
[[ "${database_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]
[[ "${bucket_name}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]
case "${mode}" in
  report-only|delete) ;;
  *)
    echo "mode must be report-only or delete" >&2
    exit 1
    ;;
esac
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GITHUB_SHA:-}"
test -n "${GITHUB_RUN_ID:-}"
test -n "${GITHUB_RUN_ATTEMPT:-}"
readonly deploy_tag="cleanup-${GITHUB_SHA:0:12}-${mode}"
readonly parent_tag_prefix="web-${GITHUB_SHA:0:12}-"

# The built configuration is the deploy contract. The collector must publish
# no route and no workers.dev address, own no schema and no assets, keep the
# parent database and the parent image bucket, and reach the live control plane
# through the MaintenanceState entrypoint alone.
jq -e \
  --arg worker_name "${worker_name}" \
  --arg parent_worker_name "${parent_worker_name}" \
  --arg parent_entrypoint "${parent_entrypoint}" \
  --arg database_id "${database_id}" \
  --arg bucket_name "${bucket_name}" \
  --arg registry_binding "${registry_binding}" \
  --arg mode "${mode}" \
  --arg cron "${cron_schedule}" '
    . as $config |
    ([$config.d1_databases[]? | select(.binding == "DB")]) as $databases |
    ([$config.r2_buckets[]? | select(.binding == $registry_binding)]) as $buckets |
    ([$config.services[]? | select(.binding == "CONTROL_PLANE")]) as $services |
    ($config.name == $worker_name) and
    (($config.workers_dev // false) == false) and
    (($config.preview_urls // false) == false) and
    ((($config.routes // []) | length) == 0) and
    ($config.assets == null) and
    (((($config.migrations // []) | length) == 0)) and
    (((($config.durable_objects.bindings // []) | length) == 0)) and
    ($config.triggers.crons == [$cron]) and
    ($config.vars.REGISTRY_CLEANUP_MODE == $mode) and
    (($databases | length) == 1) and
    ($databases[0].database_id == $database_id) and
    (($buckets | length) == 1) and
    ($buckets[0].bucket_name == $bucket_name) and
    ($buckets[0].jurisdiction == "eu") and
    (($services | length) == 1) and
    ($services[0].service == $parent_worker_name) and
    ($services[0].entrypoint == $parent_entrypoint)
  ' "${config}" >/dev/null

# The collector reads the live maintenance flag from the parent version that
# serves traffic, so that version must exist before the collector does. The
# parent bootstrap deploy of this revision therefore runs first, and this
# check proves it is the version now serving. That bootstrap version omits the
# REGISTRY_CLEANUP binding, because a binding to a service that does not exist
# yet fails the parent deploy.
bunx wrangler deployments status --name "${parent_worker_name}" --json \
  > "${parent_deployment}"
parent_active_version_id="$(jq -er '
  [.versions[] | select(.percentage == 100)] |
  select(length == 1) | .[0].version_id
' "${parent_deployment}")"
bunx wrangler versions view "${parent_active_version_id}" \
  --name "${parent_worker_name}" --json > "${parent_version}"
parent_tag="$(jq -r '.annotations["workers/tag"] // ""' "${parent_version}")"
# The REGISTRY_CLEANUP binding belongs to the parent phase that runs after this
# deploy. The bootstrap parent omits it on purpose and the full parent adds it,
# so its presence is recorded rather than required.
parent_binding_count="$(jq \
  --arg binding "${parent_binding}" '
    [.resources.bindings[] | select(.type == "service" and .name == $binding)] |
    length
  ' "${parent_version}")"
readonly parent_binding_count

# The collector needs a parent that exports MaintenanceState, the fence it reads
# on every run, and the gate route that a deployment holds it through. Two live
# parents satisfy that:
#   - the bootstrap parent of this rollout, which serves this revision and omits
#     the binding because the collector does not exist yet;
#   - an earlier parent from this feature, which carries the binding whose
#     service already answers.
parent_revision_proven=false
case "${parent_tag}" in
  "${parent_tag_prefix}"*) parent_revision_proven=true ;;
esac
readonly parent_revision_proven
if [ "${parent_revision_proven}" != true ] && [ "${parent_binding_count}" = 0 ]; then
  echo "the live control plane can not serve the image registry cleanup fence" >&2
  echo "parent_tag=${parent_tag}" >&2
  echo "expected_tag_prefix=${parent_tag_prefix}" >&2
  echo "parent_registry_cleanup_bindings=${parent_binding_count}" >&2
  exit 1
fi

# A first rollout has no collector version to compare against. Only a confirmed
# 404 from the account API counts as absent: an unreadable probe stops the
# deployment instead of looking like a first rollout.
bash "${repository_root}/tools/deploy/registry-cleanup-state.sh" \
  "${before_state}" "${before_deployment}" "${before_version}" || {
  echo 'the registry cleanup state probe failed, so this deployment can not decide.' >&2
  exit 1
}
before_version_id="$(jq -r '.active_version_id // ""' "${before_state}")"
previous_mode="$(jq -er '.mode' "${before_state}")"
script_present="$(jq -r '.script_present | tostring' "${before_state}")"
mode_proven="$(jq -r '.mode_proven | tostring' "${before_state}")"
readonly previous_mode
readonly script_present
readonly mode_proven
first_deployment=false
if [ "${script_present}" = false ]; then
  first_deployment=true
fi
readonly first_deployment

# A delete-capable collector removes registry artifacts. Three live conditions
# gate that authority, and none of them is a repeated sentence:
#   1. a deployed collector proves a servicing mode of report-only or delete;
#   2. the hold step took a report inventory from that collector, so a plan named
#      the delete set while the control plane still served;
#   3. D1 upload admission enforcement is on, so an uploader holds its
#      admission session from the first probe to the publish and cannot race
#      the collector. That state is image_registry_admission.enforcement; the
#      learner-run CLI rollout variable is unrelated and is never read here.
if [ "${mode}" = delete ]; then
  if [ "${first_deployment}" = true ]; then
    echo "the first deployment of the collector cannot delete" >&2
    echo "Deploy the report-only preview, read its candidate list, then deploy delete." >&2
    exit 1
  fi
  case "${previous_mode}" in
    report-only|delete) ;;
    *)
      echo "the live collector has no preview state" >&2
      echo "live_mode=${previous_mode}" >&2
      exit 1
      ;;
  esac
  # An unreadable mode is treated as delete-capable everywhere else, but it can
  # not stand in for the report-only preview that has to have listed the delete
  # set first.
  if [ "${mode_proven}" != true ]; then
    echo "the live collector mode is unreadable, so no preview can be proven" >&2
    echo "previous_mode=${previous_mode}" >&2
    exit 1
  fi
  inventory="${RUNNER_TEMP:-/tmp}/registry-cleanup-hold.json"
  if [ ! -f "${inventory}" ]; then
    echo "delete mode needs the hold evidence from the deployment gate" >&2
    echo "hold_evidence=${inventory}" >&2
    exit 1
  fi
  # The previous mode string is not evidence that anything was listed, and the
  # collector status is the only authority for the D1 admission switch. Both
  # come from the hold evidence this rollout recorded while the control plane
  # still served. Boolean fields are tested with has(), because jq `//` treats
  # false as absent and would report a present false as a missing field.
  inventory_problem="$(jq -r '
    (.inventory // {}) as $inventory |
    (.admission // {}) as $admission |
    if ($inventory | has("ok") | not) or $inventory.ok != true
      then "the hold step recorded no fault-free report inventory"
        + (if ($inventory | has("status")) then " (status=" + ($inventory.status | tostring) + ")" else "" end)
    elif ($admission | has("ok") | not) or $admission.ok != true then "the hold step recorded no collector status"
    elif ($admission | has("enforcement") | not) then "the hold evidence carries no D1 enforcement value"
    elif $admission.enforcement != "enforce" then "D1 upload admission enforcement is not enforce"
    elif ($admission | has("sessionRequired") | not) then "the hold evidence carries no sessionRequired value"
    elif $admission.sessionRequired != true then "the collector reports sessionRequired not true"
    else "ok" end' "${inventory}")"
  if [ "${inventory_problem}" != ok ]; then
    echo "admission enforcement must be on before the collector can delete" >&2
    echo "${inventory_problem}" >&2
    echo 'That state is image_registry_admission.enforcement in the shared database.' >&2
    exit 1
  fi
  readonly inventory
  readonly inventory_problem
fi

# The evidence below reads these files with --slurpfile, so they exist even on
# a first deployment.
touch "${before_deployment}" "${before_version}"

test ! -e "${deploy_output}"
WRANGLER_OUTPUT_FILE_PATH="${deploy_output}" \
  bunx wrangler deploy \
    --name "${worker_name}" \
    --config "${config}" \
    --tag "${deploy_tag}" \
    --message "Automatic image registry cleanup deployment for ${GITHUB_SHA}" \
    --experimental-provision=false \
    --autoconfig=false
bun "${repository_root}/tools/deploy/wrangler-output.ts" \
  "${deploy_output}" "${worker_name}" > "${deploy_result}"
deployed_version_id="$(jq -er '.versionId' "${deploy_result}")"
[[ "${deployed_version_id}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]

# The deploy event proves the tested source and the private surface: the tag
# names this revision, and an empty target list means no route and no
# workers.dev address was published.
jq -s -e --arg tag "${deploy_tag}" '
  [.[] | select(.type == "deploy")] as $deploys |
  (($deploys | length) == 1) and
  ($deploys[0].worker_tag == $tag) and
  ((($deploys[0].targets // []) | length) == 0)
' "${deploy_output}" >/dev/null

active_version_proven=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  bunx wrangler deployments status --name "${worker_name}" --json \
    > "${after_deployment}"
  if jq -e --arg version_id "${deployed_version_id}" '
    .versions | length == 1 and
    .[0].version_id == $version_id and
    .[0].percentage == 100
  ' "${after_deployment}" >/dev/null; then
    active_version_proven=true
    break
  fi
  if [ "${attempt}" -lt 10 ]; then sleep 2; fi
done
test "${active_version_proven}" = true
bunx wrangler versions view "${deployed_version_id}" \
  --name "${worker_name}" --json > "${after_version}"
jq -e \
  --arg database_id "${database_id}" \
  --arg bucket_name "${bucket_name}" \
  --arg parent_worker_name "${parent_worker_name}" \
  --arg parent_entrypoint "${parent_entrypoint}" \
  --arg mode "${mode}" '
    ([.resources.bindings[] | select(.type == "d1" and .name == "DB")]) as $databases |
    ([.resources.bindings[] | select(.type == "r2_bucket" and .name == "VM_IMAGE_REGISTRY_BUCKET")]) as $buckets |
    ([.resources.bindings[] | select(.type == "service" and .name == "CONTROL_PLANE")]) as $services |
    ([.resources.bindings[] | select(.type == "plain_text" and .name == "REGISTRY_CLEANUP_MODE")]) as $modes |
    (($databases | length) == 1) and
    ($databases[0].id == $database_id) and
    (($buckets | length) == 1) and
    ($buckets[0].bucket_name == $bucket_name) and
    (($services | length) == 1) and
    ($services[0].service == $parent_worker_name) and
    ($services[0].entrypoint == $parent_entrypoint) and
    (($modes | length) == 1) and
    ($modes[0].text == $mode)
  ' "${after_version}" >/dev/null

# Cron Triggers and the workers.dev subdomain are script settings, not version
# settings, so they are read from the account API.
schedules_status="$(curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --output "${schedules}" --write-out '%{http_code}' \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/schedules")"
test "${schedules_status}" = 200
jq -e --arg cron "${cron_schedule}" '
  .success == true and
  ((.result | length) == 1) and
  (.result[0].cron == $cron)
' "${schedules}" >/dev/null
subdomain_status="$(curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --output "${subdomain}" --write-out '%{http_code}' \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/subdomain")"
test "${subdomain_status}" = 200
jq -e '
  .success == true and
  ((.result.enabled // false) == false) and
  ((.result.previews_enabled // false) == false)
' "${subdomain}" >/dev/null

jq -n \
  --arg source_sha "${GITHUB_SHA}" \
  --arg run_id "${GITHUB_RUN_ID}" \
  --argjson run_attempt "${GITHUB_RUN_ATTEMPT}" \
  --arg worker_name "${worker_name}" \
  --arg parent_worker_name "${parent_worker_name}" \
  --arg parent_active_version_id "${parent_active_version_id}" \
  --arg parent_tag "${parent_tag}" \
  --arg cleanup_mode "${mode}" \
  --arg previous_mode "${previous_mode}" \
  --argjson script_present "${script_present}" \
  --argjson previous_mode_proven "${mode_proven}" \
  --arg deploy_tag "${deploy_tag}" \
  --arg before_version_id "${before_version_id}" \
  --arg deployed_version_id "${deployed_version_id}" \
  --arg database_id "${database_id}" \
  --arg bucket_name "${bucket_name}" \
  --arg cron "${cron_schedule}" \
  --argjson first_deployment "${first_deployment}" \
  --argjson parent_binding_count "${parent_binding_count}" \
  --argjson parent_revision_proven "${parent_revision_proven}" \
  --slurpfile before_deployment "${before_deployment}" \
  --slurpfile before_version "${before_version}" \
  --slurpfile after_deployment "${after_deployment}" \
  --slurpfile after_version "${after_version}" \
  --slurpfile parent_deployment "${parent_deployment}" \
  --slurpfile parent_version "${parent_version}" \
  --slurpfile schedules "${schedules}" \
  --slurpfile subdomain "${subdomain}" \
  --rawfile wrangler_deploy_ndjson "${deploy_output}" '
    {
      schema_version: 1,
      operation: "deploy-registry-cleanup",
      phase: "child",
      source_sha: $source_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      worker_name: $worker_name,
      cleanup_mode: $cleanup_mode,
      previous_mode: $previous_mode,
      script_present: $script_present,
      previous_mode_proven: $previous_mode_proven,
      deploy_tag: $deploy_tag,
      first_deployment: $first_deployment,
      before_version_id: (if $before_version_id == "" then null else $before_version_id end),
      deployed_version_id: $deployed_version_id,
      database_id: $database_id,
      bucket_name: $bucket_name,
      cron_schedule: $cron,
      parent_worker_name: $parent_worker_name,
      parent_active_version_id: $parent_active_version_id,
      parent_tag: $parent_tag,
      parent_binding_present: ($parent_binding_count == 1),
      parent_revision_proven: $parent_revision_proven,
      parent_capability_proven:
        ($parent_revision_proven or ($parent_binding_count == 1)),
      exact_version_active: true,
      schedule_proven: true,
      bindings_proven: true,
      private_access_proven: true,
      tested_source_proven: true,
      parent_version: $parent_version[0],
      parent_deployment: $parent_deployment[0],
      deployed_version: $after_version[0],
      deployment: $after_deployment[0],
      before_version: (if ($before_version | length) == 0 then null else $before_version[0] end),
      before_deployment: (if ($before_deployment | length) == 0 then null else $before_deployment[0] end),
      schedules: $schedules[0],
      subdomain: $subdomain[0],
      wrangler_deploy_ndjson: $wrangler_deploy_ndjson
    }
  ' > "${evidence}"
jq -e '
  .schema_version == 1 and
  .operation == "deploy-registry-cleanup" and
  .phase == "child" and
  .deployed_version_id != .before_version_id and
  .exact_version_active == true and
  .schedule_proven == true and
  .bindings_proven == true and
  .private_access_proven == true and
  .tested_source_proven == true and
  .parent_capability_proven == true and
  (.wrangler_deploy_ndjson | contains("\"type\":\"deploy\""))
' "${evidence}" >/dev/null
