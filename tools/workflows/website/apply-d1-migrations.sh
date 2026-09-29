#!/usr/bin/env bash
# Website workflow, deploy job, step "Apply pending D1 migrations".
set -euo pipefail
bun tools/database/apply-generated-migrations.ts 2>&1 | \
  tee "${RUNNER_TEMP}/production-d1-migrate.log"
