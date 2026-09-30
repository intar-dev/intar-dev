#!/usr/bin/env bash
# Website workflow, deploy job, step "Deploy production at 100 percent".
set -euo pipefail
# The tested configuration with the verified pin, maintenance off. From
# a maintenance version this deploy is what reopens the site.
WEB_DEPLOY_LABEL=standard tools/deploy/deploy-web.sh \
  "${DEPLOYMENT_CONFIG}" \
  "${DATABASE_ID}" \
  "${ACTIVATION_SECRETS_FILE}" \
  "${RUNNER_TEMP}/web-production.json"
