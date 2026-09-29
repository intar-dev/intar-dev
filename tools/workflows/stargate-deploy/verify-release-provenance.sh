#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Verify release provenance".
set -euo pipefail
tag_commit="$(git rev-parse --verify "${RELEASE_TAG}^{commit}")"
git merge-base --is-ancestor "${tag_commit}" "${GITHUB_SHA}"
version="${RELEASE_TAG#stargate/v}"
manifest_version="$(
  git show "${RELEASE_TAG}:crates/stargate-gateway/Cargo.toml" |
    awk -F ' *= *' '$1 == "version" {gsub(/"/, "", $2); print $2; exit}'
)"
test "${manifest_version}" = "${version}"
