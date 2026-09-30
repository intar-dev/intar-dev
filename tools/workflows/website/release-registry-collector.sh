#!/usr/bin/env bash
# deploy.yml, job deploy-web, step "Release the image registry collector".
set -euo pipefail
# A hold that left no evidence stopped before its pause answered, mostly
# because its admission or inventory proof refused, which an operator's pause
# or a sweep in flight does. Releasing would resume a pause this run never
# took, so the collector stays as the hold found it. A pause the hold may have
# placed without a readable answer carries registry_cleanup_hold, which the
# next deploy releases.
if [ ! -e "${RUNNER_TEMP}/registry-cleanup-hold.json" ]; then
  echo 'The hold wrote no evidence, so it paused nothing to release; the collector stays as it was.'
  exit 0
fi
# The hold lives in the shared admission row and does not expire, so
# this step runs after the parent reopened with the binding and must
# prove that no hold survives the rollout. A gate that can not be
# reached fails the step when this run placed a hold, and records an
# absent gate when it did not. While the lane's own maintenance version
# still serves, after a failure, the gate is fenced: the step leaves the
# hold for the deploy that reopens the parent and passes.
tools/deploy/registry-cleanup-gate.sh release report-only \
  "${RUNNER_TEMP}/registry-cleanup-release.json"
