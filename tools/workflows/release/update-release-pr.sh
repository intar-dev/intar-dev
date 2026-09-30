#!/usr/bin/env bash
# release.yml, job release-pr, step "Update the release pull request".
# Rebuilds release/next from this main commit: each product git-cliff finds
# changes for gets its bumped manifest version, Cargo.lock entry, and
# changelog. The app token pushes, so CI runs on the pull request; with nothing
# to release, the pull request is closed.
set -euo pipefail
# A re-run keeps its run's commit. Only the run for main's tip may rewrite the
# pull request; a push that moved main has a run of its own that follows.
main="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
if [ "${main}" != "${GITHUB_SHA}" ]; then
  echo "main moved on to ${main}; its run updates the release pull request."
  exit 0
fi
branch=release/next
config=tools/workflows/release/cliff.toml
bot="${APP_SLUG}[bot]"
bot_id="$(gh api "users/${bot}" --jq .id)"
git config user.name "${bot}"
git config user.email "${bot_id}+${bot}@users.noreply.github.com"
gh auth setup-git --hostname github.com
git checkout -B "${branch}" "${GITHUB_SHA}"

# One product's git-cliff scope: its anchored tags and its path globs.
cliff_args='"--tag-pattern", "^\(.prefix)/v[0-9]+\\.[0-9]+\\.[0-9]+$", (.paths[] | "--include-path", .)'
mapfile -t product_list < <(jq -c '.[]' tools/workflows/release/products.json)
body="$(mktemp)"
cat >"${body}" <<'EOF'
Merging this pull request tags and publishes the releases below. It is rebuilt from main on every push, so a change made here is lost: set a different version through a normal pull request instead.
EOF
tags=()
for product in "${product_list[@]}"; do
  prefix="$(jq -r .prefix <<<"${product}")"
  manifest="$(jq -r .manifest <<<"${product}")"
  current="$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "${manifest}" | head -n 1)"
  # The plan job tags a new manifest version only once CI passes on main, which
  # can follow this push. Until then, a local tag where plan-release.sh puts it
  # counts that version as released; it is never pushed.
  if ! git rev-parse --quiet --verify "refs/tags/${prefix}/v${current}" >/dev/null; then
    git tag "${prefix}/v${current}" \
      "$(git log --first-parent -1 --format=%H -G '^version = "' -- "${manifest}")"
  fi
  mapfile -t cliff < <(jq -r "${cliff_args}" <<<"${product}")
  # With nothing to release, git-cliff prints the latest tag, the manifest
  # version.
  next="$(git-cliff --config "${config}" "${cliff[@]}" --unreleased --bumped-version)"
  if [ "${next}" = "${prefix}/v${current}" ]; then
    continue
  fi
  version="${next#"${prefix}/v"}"
  if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "git-cliff proposed ${next} for ${prefix}." >&2
    exit 1
  fi
  MANIFEST="${manifest}" PACKAGE="$(jq -r .package <<<"${product}")" VERSION="${version}" \
    tools/workflows/release/apply-release-version.sh
  changelog="$(dirname "${manifest}")/CHANGELOG.md"
  git-cliff --config "${config}" "${cliff[@]}" --unreleased --tag "${next}" --prepend "${changelog}"
  notes="$(git-cliff --config "${config}" "${cliff[@]}" --unreleased --tag "${next}" --strip all)"
  printf '%s\n' "${notes}" >>"${body}"
  git add "${manifest}" Cargo.lock "${changelog}"
  tags+=("${next}")
done

open_pr() {
  gh pr list --head "${branch}" --base main --state open --json number --jq '.[0].number // empty'
}
if [ "${#tags[@]}" -eq 0 ]; then
  pr="$(open_pr)"
  if [ -n "${pr}" ]; then
    gh pr close "${pr}" --delete-branch --comment "Nothing to release at ${GITHUB_SHA}."
  fi
  echo "Nothing to release."
  exit 0
fi
joined="${tags[*]}"
title="chore(release): ${joined// /, }"
git commit --quiet -m "${title}"
tools/workflows/release/push-bot-branch.sh "${branch}"
pr="$(open_pr)"
if [ -n "${pr}" ]; then
  gh pr edit "${pr}" --title "${title}" --body-file "${body}"
else
  gh pr create --base main --head "${branch}" --title "${title}" --body-file "${body}"
fi
echo "${title}" >> "${GITHUB_STEP_SUMMARY}"
