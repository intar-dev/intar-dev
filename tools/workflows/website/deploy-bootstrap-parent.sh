#!/usr/bin/env bash
# Website workflow, deploy job, step "Deploy the parent revision for the first cleanup rollout".
set -euo pipefail
# Nothing else deploys the parent on this path, and the collector needs
# a parent version that exports MaintenanceState before it can read the
# maintenance fence. This deploy carries the bootstrap configuration:
# everything from the tested artifact except the binding to the
# collector, which does not exist yet.
tools/deploy/deploy-web.sh \
  "${BOOTSTRAP_DEPLOYMENT_CONFIG}" \
  "${DATABASE_ID}" \
  "${ACTIVATION_SECRETS_FILE}" \
  "${RUNNER_TEMP}/web-bootstrap.json"
