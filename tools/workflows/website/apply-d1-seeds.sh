#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Apply production D1 seeds".
set -euo pipefail
bun tools/database/apply-seeds.ts
