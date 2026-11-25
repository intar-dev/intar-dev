#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Pin the published releases".
# Writes the releases the website serves into the deployment configuration:
# the scenario compiler, the desktop app's update, and the Kino pins
# (tools/deploy/release-pins.ts). Only a release that is published, on main and
# attested by release.yml on main is pinned, and a Kino only once the registry
# stores its artifact; a prerelease is held back.
set -euo pipefail
test -f "${DEPLOYMENT_CONFIG}"
bun tools/deploy/release-pins.ts
