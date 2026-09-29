#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Verify published Kino source" step.
set -euo pipefail
gh release view "${KINO_TAG}" --json isDraft,isPrerelease \
  | jq -e '.isDraft == false and .isPrerelease == false' >/dev/null
test "$(git cat-file -t "refs/tags/${KINO_TAG}")" = tag
source_sha="$(git rev-parse "refs/tags/${KINO_TAG}^{commit}")"
git merge-base --is-ancestor "${source_sha}" "${GITHUB_SHA}"
git worktree add --detach "${RUNNER_TEMP}/kino-source" "${source_sha}"
jq -n --arg tag "${KINO_TAG}" --arg source "${source_sha}" \
  --arg workflow "${GITHUB_SHA}" \
  '{tag: $tag, source_sha: $source, workflow_sha: $workflow, profile: "guest", target: "x86_64-unknown-linux-musl"}' \
  > "${TOOLS_DIR}/provenance.json"
