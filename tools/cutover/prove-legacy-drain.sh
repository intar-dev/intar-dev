#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: prove-legacy-drain.sh <database-name> <database-id> <phase> <evidence.json>" >&2
  exit 64
fi

readonly database_name="$1"
readonly database_id="$2"
readonly phase="$3"
readonly evidence="$4"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly runtime_root="${RUNNER_TEMP:-/tmp}/intar-clean-d1-drain-${GITHUB_RUN_ID:-local}-${phase}"
readonly config="${runtime_root}/wrangler.jsonc"
readonly raw="${runtime_root}/d1.json"
readonly provider="${runtime_root}/provider.json"
readonly stargate_raw="${runtime_root}/stargate-plan.txt"
readonly stargate="${runtime_root}/stargate.json"
readonly drain_query="${repository_root}/tools/cutover/legacy-drain.sql"

[[ "${database_name}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
[[ "${database_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "${phase}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]
test -n "${CLOUDFLARE_ACCOUNT_ID:-}"
test -n "${CLOUDFLARE_D1_API_TOKEN:-}"
test -n "${CLOUDFLARE_PROVIDER_PROBE_API_TOKEN:-}"
test -n "${STARGATE_SSH_CONFIG:-}"
test -f "${STARGATE_SSH_CONFIG}"
test ! -L "${STARGATE_SSH_CONFIG}"
test -f "${drain_query}"
test ! -L "${drain_query}"

mkdir -p "${runtime_root}" "$(dirname "${evidence}")"
jq -n \
  --arg name "${database_name}" \
  --arg id "${database_id}" \
  '{name: "intar-clean-d1-legacy-drain", compatibility_date: "2026-07-09", d1_databases: [{binding: "LEGACY_DB", database_name: $name, database_id: $id}]}' \
  > "${config}"

readonly drain_sql="$(tr '\n' ' ' < "${drain_query}")"

query_succeeded=false
provider_succeeded=false
stargate_succeeded=false
if CLOUDFLARE_API_TOKEN="${CLOUDFLARE_D1_API_TOKEN}" \
  bunx wrangler d1 execute LEGACY_DB \
    --remote \
    --config "${config}" \
    --command "${drain_sql}" \
    --json > "${raw}"; then
  query_succeeded=true
fi
if [ "${query_succeeded}" = true ] && ! jq -e '
  length == 1 and
  .[0].success == true and
  (.[0].results | length) == 1 and
  (.[0].results[0].observed_at | type == "number")
' "${raw}" >/dev/null; then
  query_succeeded=false
fi

if [ "${query_succeeded}" = true ] && \
  CLOUDFLARE_API_TOKEN="${CLOUDFLARE_PROVIDER_PROBE_API_TOKEN}" \
  bun "${repository_root}/tools/cutover/probe-legacy-provider-inventory.ts" \
    "${database_name}" "${database_id}" "${provider}"; then
  provider_succeeded=true
fi

if ssh -F "${STARGATE_SSH_CONFIG}" \
  intar-stargate-production plan > "${stargate_raw}" && \
  bun "${repository_root}/tools/cutover/stargate-plan.ts" \
    "${stargate_raw}" "${stargate}"; then
  stargate_succeeded=true
fi

if ! jq empty "${raw}" >/dev/null 2>&1; then
  jq -n '[]' > "${raw}"
fi
if ! jq empty "${provider}" >/dev/null 2>&1; then
  jq -n 'null' > "${provider}"
fi
if ! jq empty "${stargate}" >/dev/null 2>&1; then
  jq -n 'null' > "${stargate}"
fi

jq -n \
  --arg source_sha "${GITHUB_SHA:-local}" \
  --arg database_name "${database_name}" \
  --arg database_id "${database_id}" \
  --arg phase "${phase}" \
  --argjson query_succeeded "${query_succeeded}" \
  --argjson provider_succeeded "${provider_succeeded}" \
  --argjson stargate_succeeded "${stargate_succeeded}" \
  --slurpfile d1 "${raw}" \
  --slurpfile provider "${provider}" \
  --slurpfile stargate "${stargate}" '
    ($d1[0][0].results[0] // null) as $row |
    ($provider[0] // null) as $provider_evidence |
    ($stargate[0] // null) as $stargate_evidence |
    (if $row == null then null else ($row | del(.observed_at) | with_entries(select((.key | startswith("residual_")) | not))) end) as $blocking_counts |
    (if $row == null then null else ($row | del(.observed_at) | with_entries(select(.key | startswith("residual_"))) | with_entries(.key |= sub("^residual_"; ""))) end) as $residual_counts |
    {
      schema_version: 4,
      operation: "legacy-drain",
      phase: $phase,
      source_sha: $source_sha,
      database_name: $database_name,
      database_id: $database_id,
      query_succeeded: $query_succeeded,
      provider_probe_succeeded: $provider_succeeded,
      stargate_probe_succeeded: $stargate_succeeded,
      observed_at: ($row.observed_at // null),
      counts: $blocking_counts,
      residual_counts: $residual_counts,
      provider_inventory: $provider_evidence,
      stargate: $stargate_evidence,
      drained: (
        $query_succeeded and
        $provider_succeeded and
        $stargate_succeeded and
        $row != null and
        ($blocking_counts | length) > 0 and
        ($blocking_counts | to_entries | all(.value == 0)) and
        $provider_evidence.provenEmpty == true and
        $stargate_evidence.healthy == true and
        $stargate_evidence.drained == true
      )
    }
  ' > "${evidence}"

jq -e '
  .schema_version == 4 and
  .query_succeeded == true and
  .provider_probe_succeeded == true and
  .stargate_probe_succeeded == true and
  .drained == true and
  (.counts | type == "object") and
  .provider_inventory.connectionCount > 0 and
  .provider_inventory.provenEmpty == true and
  .stargate.healthy == true and
  .stargate.drained == true
' "${evidence}" >/dev/null
