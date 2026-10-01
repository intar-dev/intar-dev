#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Summarize the deployment".
set -uo pipefail
# Runs after every deploy, also a failed one, so it reads whatever
# evidence exists and never fails: a missing file prints "none".
field() {
  jq -r "($2) // \"none\" | tostring" "${RUNNER_TEMP}/$1" 2>/dev/null || echo none
}
code() {
  printf '\x60%s\x60' "$1"
}
row() {
  printf '| %s | %s |\n' "$1" "$2"
}
# A D1 ledger count names the tag of the last migration it covers.
migration() {
  local count="$1" tag
  if [[ "${count}" =~ ^[1-9][0-9]*$ ]]; then
    # shellcheck disable=SC2016
    tag="$(jq -r --argjson n "${count}" '.entries[$n - 1].tag // "unknown"' \
      apps/web/migrations/meta/_journal.json 2>/dev/null || echo unknown)"
    printf '%s (%s)' "$(code "${tag}")" "${count}"
  else
    printf 'none'
  fi
}

maintenance_version="$(field web-maintenance.json .deployed_version_id)"
production_version="$(field web-production.json .deployed_version_id)"
# The version that served before this run: the maintenance deploy's
# predecessor when this run enabled maintenance, else the production
# deploy's.
before_version="$(field web-maintenance.json .before_version_id)"
if [ "${before_version}" = none ]; then
  before_version="$(field web-production.json .before_version_id)"
fi
case "$(field registry-cleanup-hold.json .gate)" in
  recovery) recovery="yes, behind $(code "$(field registry-cleanup-hold.json .recovery.parent_tag)")" ;;
  none) recovery="no hold evidence" ;;
  *) recovery=no ;;
esac
case "$(field registry-cleanup-release.json '.gate + "/" + .hold_leave')" in
  recovery/left) release="held; the deploy that reopens the site releases it" ;;
  ok/*) release="released" ;;
  none) release="not reached" ;;
  *) release="$(field registry-cleanup-release.json .gate)" ;;
esac
maintenance="not used"
if [ "${maintenance_version}" != none ]; then
  maintenance="$(code "${maintenance_version}")"
fi

{
  printf '## Website deploy\n\n| | |\n|---|---|\n'
  row Source "$(code "${GITHUB_SHA}")"
  row "Tested artifact" "$(code "${TESTED_ARTIFACT_DIGEST:-none}")"
  row "Guest-tools pin" "$(code "$(field release-static-pin-evidence.json .static_pin_sha256)")"
  row "D1 applied before" "$(migration "$(field production-d1-plan.json .appliedMigrationCount)")"
  row "D1 applied now" "$(migration "$(field production-d1-verified.json .appliedMigrationCount)")"
  row "D1 committed" "$(migration "$(field production-d1-plan.json .committedMigrationCount)")"
  row Maintenance "${maintenance}"
  row Recovery "${recovery}"
  row "Worker version" "$(code "${production_version}")"
  row "Served before this run" "$(code "${before_version}")"
  row Collector "$(code "$(field registry-cleanup-deploy.json .deployed_version_id)"), $(field registry-cleanup-deploy.json .cleanup_mode) mode"
  row "Collector release" "${release}"
  if [ "${before_version}" != none ]; then
    printf '\nBreak-glass: roll the Worker back to the version that served before this run. D1 migrations do not roll back, so do this only when that code runs on the current schema.\n\n'
    printf '\x60\x60\x60sh\nbunx wrangler rollback %s --name intar-dev\n\x60\x60\x60\n' "${before_version}"
  fi
} >> "${GITHUB_STEP_SUMMARY}"
exit 0
