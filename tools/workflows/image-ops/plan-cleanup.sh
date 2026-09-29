#!/usr/bin/env bash
# image-ops workflow, cleanup job, "List the candidate set" step.
set -euo pipefail
evidence_dir="${RUNNER_TEMP}/intar-image-registry-cleanup"
# A plan runs only while the collector is idle, so the listing can not
# race a sweep that is already in flight.
jq -e '.idle == true' "${evidence_dir}/state.json" >/dev/null
tools/deploy/registry-cleanup-gate.sh plan delete \
  "${evidence_dir}/registry-cleanup-plan.json"
