#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Release the image registry collector".
set -euo pipefail
# The hold lives in the shared admission row and does not expire, so
# this step runs after the parent reopened with the binding and must
# prove that no hold survives the rollout. A gate that can not be
# reached fails the step when this run placed a hold, and records an
# absent gate when it did not. While the lane's own maintenance version
# still serves, after a failure, the gate is fenced: the step leaves the
# hold for the deploy that reopens the parent and passes.
tools/deploy/registry-cleanup-gate.sh release report-only \
  "${RUNNER_TEMP}/registry-cleanup-release.json"
