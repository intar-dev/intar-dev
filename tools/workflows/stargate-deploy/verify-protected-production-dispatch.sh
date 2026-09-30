#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Verify protected production dispatch".
set -euo pipefail
test "${GITHUB_REF}" = refs/heads/main
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
test "${DEPLOY_HOST}" = intar.app
test "${DEPLOY_PORT}" = 2222
test "${DEPLOY_USER}" = stargate-deploy
test "${GITHUB_REPOSITORY}" = intar-dev/intar-dev

printf 'actor=%s\n' "${GITHUB_ACTOR}" | tee -a "${GITHUB_STEP_SUMMARY}"

branch_policies="$(gh api "repos/${GITHUB_REPOSITORY}/environments/production/deployment-branch-policies")"
jq -e '
  (.branch_policies // .) as $policies |
  ($policies | length) == 1 and
  $policies[0].type == "branch" and
  $policies[0].name == "main"
' <<<"${branch_policies}" >/dev/null
