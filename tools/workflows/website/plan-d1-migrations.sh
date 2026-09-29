#!/usr/bin/env bash
# Website workflow, deploy job, step "Plan production D1 migrations".
set -euo pipefail
evidence="${RUNNER_TEMP}/production-d1-plan.json"
bun tools/database/verify-generated-d1-schema.ts \
  --database-id "${DATABASE_ID}" \
  --expect observed-ledger-prefix \
  --evidence "${evidence}"
applied="$(jq -er '.appliedMigrationCount' "${evidence}")"
committed="$(jq -er '.committedMigrationCount' "${evidence}")"
[[ "${applied}" =~ ^[1-9][0-9]*$ ]]
[[ "${committed}" =~ ^[1-9][0-9]*$ ]]
test "${applied}" -le "${committed}"
if [ "${applied}" -lt "${committed}" ]; then
  pending=true
else
  pending=false
fi
{
  printf 'pending=%s\n' "${pending}"
  printf 'applied=%s\n' "${applied}"
  printf 'committed=%s\n' "${committed}"
} >> "${GITHUB_OUTPUT}"
printf 'd1_applied=%s d1_committed=%s d1_pending=%s\n' \
  "${applied}" "${committed}" "${pending}" \
  >> "${GITHUB_STEP_SUMMARY}"
