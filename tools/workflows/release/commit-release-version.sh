#!/usr/bin/env bash
# release.yml, job release, step "Commit release version".
set -euo pipefail
if [ "${RESUME}" = "true" ]; then
  if [ "$(git rev-parse HEAD)" != "${RESUME_SHA}" ]; then
    echo "Resume checkout moved away from ${RESUME_SHA}." >&2
    exit 1
  fi
  if ! git diff --quiet --exit-code -- "${MANIFEST}" Cargo.lock; then
    echo "Resume verification modified release inputs." >&2
    exit 1
  fi
  echo "sha=${RESUME_SHA}" >> "${GITHUB_OUTPUT}"
  exit 0
fi

# Publish the version commit only after every build and privileged
# package smoke has passed. Keep it local until the tag and branch
# can be pushed atomically; a failed release must not mutate main.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git diff --quiet --exit-code -- "${MANIFEST}" Cargo.lock; then
  release_sha="$(git rev-parse HEAD)"
else
  git add "${MANIFEST}" Cargo.lock
  git commit -m "chore(${PROJECT}): release ${VERSION_TAG}"
  release_sha="$(git rev-parse HEAD)"
fi
echo "sha=${release_sha}" >> "${GITHUB_OUTPUT}"
