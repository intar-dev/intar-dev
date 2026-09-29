#!/usr/bin/env bash
# Website workflow, deploy job, step "Verify production D1 schema".
set -euo pipefail
evidence="${RUNNER_TEMP}/production-d1-verified.json"
bun tools/database/verify-generated-d1-schema.ts \
  --database-id "${DATABASE_ID}" \
  --expect full \
  --evidence "${evidence}"
jq -e '
  .status == "exact_generated_schema_verified" and
  .expectation == "full" and
  .appliedMigrationCount == .committedMigrationCount and
  .foreignKeyViolations == 0 and
  .triggers == 0 and
  .views == 0
' "${evidence}" >/dev/null
