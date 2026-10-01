#!/usr/bin/env bash
# image-ops workflow, tools-promote job, "Read the candidate pin from the registry bucket" step.
cd apps/web
set -euo pipefail
bunx wrangler r2 object get "${BUCKET}/guest-tools/scenario/candidate.json" \
  --remote --jurisdiction eu --file "${TOOLS_DIR}/candidate.json"
jq -e '.schema_version == 1 and .bootstrap_abi == 2' \
  "${TOOLS_DIR}/candidate.json" >/dev/null
# Bind the promotion to the exact candidate the operator chose from
# the tools build. The build lane may run again before this promotion,
# so the downloaded manifest must equal the digest that was chosen, or
# this run would promote a different release than the one verified.
measured_sha="$(sha256sum "${TOOLS_DIR}/candidate.json" | cut -d ' ' -f 1)"
if [ "${measured_sha}" != "${EXPECTED_CANDIDATE_SHA256}" ]; then
  echo 'The published candidate does not match the expected digest.' >&2
  echo "expected=${EXPECTED_CANDIDATE_SHA256}" >&2
  echo "measured=${measured_sha}" >&2
  exit 1
fi
printf 'candidate_sha256=%s\n' "${measured_sha}"
