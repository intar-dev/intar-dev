#!/usr/bin/env bash
# release.yml, job plan, step "Plan releases".
# What this main commit releases, at most one entry per product:
#   - resume: the product's latest tag has no published release, because a
#     publish failed after tagging. It is rebuilt from that tag.
#   - new: git-cliff finds releasable commits since the latest tag, together
#     with the dependency fixes deps-commits.py maps to the product. The next
#     version is built from this commit, and publish tags it only once the
#     build passed, so a failed build burns no version.
# Versions live in tags, not in the manifests on main: build applies the
# version to its checkout. Each new entry gets a draft release with its notes,
# targeting this commit; a draft left by an earlier failed build is reused or,
# when the version moved on, deleted. The matrix says whether CI passed on the
# commit: build runs the workspace gate only when not.
set -euo pipefail
products=tools/workflows/release/products.json
config=tools/workflows/release/cliff.toml
# One product's git-cliff scope: its anchored tags and its path globs.
cliff_args='"--tag-pattern", "^\(.prefix)/v[0-9]+\\.[0-9]+\\.[0-9]+$", (.paths[] | "--include-path", .)'
latest_tag() {
  git tag --list "$1/v*" | { grep -E "^$1/v[0-9]+\.[0-9]+\.[0-9]+$" || true; } | sort -V | tail -n 1
}
release_state() {
  gh release view "$1" --json isDraft --jq 'if .isDraft then "draft" else "published" end' 2>/dev/null || echo missing
}
# Whether a ci.yml run passed for the commit: the merge group that landed it,
# or a run dispatched from main.
ci_passed() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=$1&status=success" \
    --jq '[.workflow_runs[] | select((.event == "merge_group" and (.head_branch | startswith("gh-readonly-queue/main/"))) or (.event == "workflow_dispatch" and .head_branch == "main"))] | length > 0'
}
mapfile -t product_list < <(jq -c '.[]' "${products}")
matrix='[]'
for product in "${product_list[@]}"; do
  project="$(jq -r .project <<<"${product}")"
  prefix="$(jq -r .prefix <<<"${product}")"
  latest="$(latest_tag "${prefix}")"
  [ -n "${latest}" ] || { echo "${prefix} has no release tag to version from." >&2; exit 1; }
  mapfile -t cliff < <(jq -r "${cliff_args}" <<<"${product}")

  if [ "$(release_state "${latest}")" != published ]; then
    test "$(git cat-file -t "refs/tags/${latest}")" = tag
    git merge-base --is-ancestor "${latest}^{commit}" "${GITHUB_SHA}"
    version="${latest#"${prefix}/v"}"
    # plan creates each draft before publish tags it, so a tag without a
    # release lost it afterwards; git-cliff writes its notes again.
    if [ "$(release_state "${latest}")" = missing ]; then
      notes="$(git-cliff --config "${config}" "${cliff[@]}" --latest --strip all)"
      gh release create "${latest}" --draft --verify-tag --title "${project} v${version}" --notes "${notes}"
    fi
    entry="$(jq -c --arg tag "${latest}" --arg version "${version}" --arg ref "$(git rev-parse "${latest}^{commit}")" \
      '{tag: $tag, version: $version, ref: $ref, create_tag: false}' <<<'{}')"
  else
    deps="$(python3 tools/workflows/release/deps-commits.py "${latest}" "${product}")"
    if [ -n "${deps}" ]; then
      while IFS= read -r commit; do
        cliff+=(--with-commit "${commit}")
      done <<<"${deps}"
    fi
    # With nothing to release, git-cliff prints the latest tag.
    next="$(git-cliff --config "${config}" "${cliff[@]}" --unreleased --bumped-version)"
    # A draft whose build failed before a newer version was planned is stale.
    gh release list --limit 1000 --json tagName,isDraft \
      --jq ".[] | select(.isDraft and (.tagName | startswith(\"${prefix}/v\")) and .tagName != \"${next}\") | .tagName" |
      while IFS= read -r stale; do
        git rev-parse --quiet --verify "refs/tags/${stale}" >/dev/null || gh release delete "${stale}" --yes </dev/null
      done
    if [ "${next}" = "${latest}" ]; then
      continue
    fi
    version="${next#"${prefix}/v"}"
    if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "git-cliff proposed ${next} for ${prefix}." >&2
      exit 1
    fi
    # --bump names the section ${next}, computed from the same commits. --tag
    # would put the --with-commit commits in a section of their own.
    notes="$(git-cliff --config "${config}" "${cliff[@]}" --unreleased --bump --strip all)"
    if [ "$(release_state "${next}")" = missing ]; then
      gh release create "${next}" --draft --target "${GITHUB_SHA}" --title "${project} v${version}" --notes "${notes}"
    else
      gh release edit "${next}" --draft --target "${GITHUB_SHA}" --title "${project} v${version}" --notes "${notes}"
    fi
    entry="$(jq -c --arg tag "${next}" --arg version "${version}" --arg ref "${GITHUB_SHA}" \
      '{tag: $tag, version: $version, ref: $ref, create_tag: true}' <<<'{}')"
  fi
  passed="$(ci_passed "$(jq -r .ref <<<"${entry}")")"
  matrix="$(jq -c --argjson product "${product}" --argjson entry "${entry}" --argjson ci_passed "${passed}" \
    '. + [$product + $entry + {ci_passed: $ci_passed} | del(.paths)]' <<<"${matrix}")"
done
echo "matrix=${matrix}" >> "${GITHUB_OUTPUT}"
echo "Release matrix: ${matrix}"
