#!/usr/bin/env bash
# Live state of the image registry cleanup worker, for the deployment lanes.
#
#   usage: tools/deploy/registry-cleanup-state.sh <evidence.json> [deployments.json] [version.json]
#
# A missing Worker is the only absent answer that counts, and it arrives as an
# exact HTTP 404 from the account API. Every other answer - an expired token, a
# forbidden account, a network failure, an unparseable body - is indeterminate
# and exits non-zero, so no caller can read it as "nothing is deployed" and skip
# a hold it needed.
#
# The probe reads the script settings endpoint, which answers JSON. The bare
# script endpoint answers the multipart JavaScript source of a present Worker,
# and no JSON reader can confirm that. A 200 counts only when its body is one
# Cloudflare success document, and a 404 counts only when its body carries the
# worker-not-found code 10007 that the installed Wrangler treats as "this Worker
# does not exist".
#
# The probe writes:
#   script_present      true when a script with that name exists
#   active_version_id   the single version at 100 percent, or null
#   mode                report-only, delete, or absent
#   mode_proven         true only when the live version carried the mode binding
#
# A present script whose version or mode can not be read reports mode delete:
# the gate must never widen the collector's authority by guessing.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "usage: tools/deploy/registry-cleanup-state.sh <evidence.json> [deployments.json] [version.json]" >&2
  exit 64
fi

readonly evidence="$1"
readonly deployments="${2:-}"
readonly version="${3:-}"
readonly worker_name="${REGISTRY_CLEANUP_WORKER_NAME:-intar-dev-image-registry-cleanup}"
readonly settings_body="${evidence}.settings.json"

test -n "${CLOUDFLARE_ACCOUNT_ID:-}" || {
  echo "the registry cleanup probe needs CLOUDFLARE_ACCOUNT_ID" >&2
  exit 1
}
test -n "${CLOUDFLARE_API_TOKEN:-}" || {
  echo "the registry cleanup probe needs CLOUDFLARE_API_TOKEN" >&2
  exit 1
}

settings_status="$(curl --silent --show-error --max-time 60 \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --output "${settings_body}" --write-out '%{http_code}' \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/settings" \
  || true)"

# -s slurps the body into one array, so anything that is not exactly one JSON
# document - the multipart source of the other endpoint, an HTML error page, an
# empty file - fails the test instead of passing it by accident.
case "${settings_status}" in
  200)
    jq -es 'length == 1 and (.[0].success == true)' "${settings_body}" >/dev/null || {
      echo 'the registry cleanup probe read a 200 that is not a Cloudflare settings answer' >&2
      echo 'An unreadable probe is not an absent worker, so the deployment stops here.' >&2
      exit 1
    }
    script_present=true
    ;;
  404)
    jq -es 'length == 1 and (.[0].success == false)
      and (any(.[0].errors[]?; .code? == 10007))' "${settings_body}" >/dev/null || {
      echo 'the registry cleanup probe read a 404 that is not a Cloudflare worker-not-found answer' >&2
      echo 'An unreadable probe is not an absent worker, so the deployment stops here.' >&2
      exit 1
    }
    script_present=false
    ;;
  *)
    echo "the registry cleanup probe could not read the worker: HTTP ${settings_status:-none}" >&2
    echo 'An unreadable probe is not an absent worker, so the deployment stops here.' >&2
    exit 1
    ;;
esac

active_version_id=""
mode="absent"
mode_proven=false
tag=""

if [ "${script_present}" = true ]; then
  if [ -n "${deployments}" ]; then
    # A present script whose deployment can not be read is indeterminate: a
    # failed read must never look like a first rollout.
    bunx wrangler deployments status --name "${worker_name}" --json \
      > "${deployments}" || {
      echo "the registry cleanup probe could not read the deployments of ${worker_name}" >&2
      exit 1
    }
    active_version_id="$(jq -er '
      [.versions[] | select(.percentage == 100)] |
      if length == 1 then .[0].version_id else "" end
    ' "${deployments}")" || {
      echo 'the registry cleanup probe read a deployment listing it can not parse' >&2
      exit 1
    }
  fi
  if [ -n "${active_version_id}" ] && [ -n "${version}" ]; then
    bunx wrangler versions view "${active_version_id}" \
      --name "${worker_name}" --json > "${version}" || {
      echo "the registry cleanup probe could not read version ${active_version_id}" >&2
      exit 1
    }
    mode="$(jq -r '
      ([.resources.bindings[]?
        | select(.type == "plain_text" and .name == "REGISTRY_CLEANUP_MODE")] |
        if (length == 1) and (.[0].text == "report-only") then "report-only"
        else "delete" end)
    ' "${version}")"
    mode_proven="$(jq -r '
      ([.resources.bindings[]?
        | select(.type == "plain_text" and .name == "REGISTRY_CLEANUP_MODE")] |
        if (length == 1) and (.[0].text == "report-only" or .[0].text == "delete")
        then true else false end)
    ' "${version}")"
    # The deploy tag names the revision and the mode of the deployed build, so
    # a lane can tell an unchanged collector from one that must be replaced.
    tag="$(jq -r '.annotations["workers/tag"] // ""' "${version}")"
  elif [ -n "${deployments}" ]; then
    # The script exists but no single version serves. No collector answers yet,
    # so nothing can delete, but the mode is unproven and stays delete-capable.
    mode="delete"
  fi
fi

# A present script whose mode could not be read is delete-capable: an unproven
# mode must never widen the collector's authority.
if [ "${script_present}" = true ] && [ "${mode}" = absent ]; then
  mode="delete"
fi

jq -n \
  --arg worker_name "${worker_name}" \
  --arg script_status "${settings_status}" \
  --arg active_version_id "${active_version_id}" \
  --arg mode "${mode}" \
  --arg tag "${tag}" \
  --argjson script_present "${script_present}" \
  --argjson mode_proven "${mode_proven}" \
  --slurpfile settings "${settings_body}" \
  '{
    schema_version: 1,
    operation: "registry-cleanup-state",
    worker_name: $worker_name,
    script_present: $script_present,
    script_status: $script_status,
    active_version_id: (if $active_version_id == "" then null else $active_version_id end),
    mode: $mode,
    tag: (if $tag == "" then null else $tag end),
    mode_proven: $mode_proven,
    script_response: (if ($settings | length) == 0 then null else $settings[0] end)
  }' > "${evidence}"

rm -f "${settings_body}"
exit 0
