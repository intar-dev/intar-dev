#!/usr/bin/env bash
# release.yml, job plan, step "Plan releases".
# A product whose manifest version on main has no tag gets an annotated
# <prefix>/vX.Y.Z tag on the commit that set that version and a draft release
# with git-cliff notes. Every release still in draft goes into the build
# matrix, which is how a failed run resumes.
set -euo pipefail
products=tools/workflows/release/products.json
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
gh auth setup-git --hostname github.com
manifest_version() {
  sed -n 's/^version = "\([^"]*\)".*/\1/p' | head -n 1
}
# One product's git-cliff scope: its anchored tags and its path globs.
cliff_args='"--tag-pattern", "^\(.prefix)/v[0-9]+\\.[0-9]+\\.[0-9]+$", (.paths[] | "--include-path", .)'
mapfile -t product_list < <(jq -c '.[]' "${products}")
matrix='[]'
for product in "${product_list[@]}"; do
  project="$(jq -r .project <<<"${product}")"
  prefix="$(jq -r .prefix <<<"${product}")"
  package="$(jq -r .package <<<"${product}")"
  manifest="$(jq -r .manifest <<<"${product}")"
  version="$(manifest_version <"${manifest}")"
  if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "${manifest} has no plain release version: ${version}" >&2
    exit 1
  fi
  if [ "$(grep -A1 -Fx "name = \"${package}\"" Cargo.lock | grep -cFx "version = \"${version}\"")" != 1 ]; then
    echo "Cargo.lock does not pin ${package} ${version}." >&2
    exit 1
  fi
  tag="${prefix}/v${version}"
  if ! git rev-parse --quiet --verify "refs/tags/${tag}" >/dev/null; then
    source_sha="$(git log --first-parent -1 --format=%H -G '^version = "' -- "${manifest}")"
    git tag -a "${tag}" "${source_sha}" -m "${project} v${version}"
    git push origin "refs/tags/${tag}"
  fi
  test "$(git cat-file -t "refs/tags/${tag}")" = tag
  git merge-base --is-ancestor "${tag}^{commit}" "${GITHUB_SHA}"
  test "$(git show "${tag}^{commit}:${manifest}" | manifest_version)" = "${version}"

  draft="$(gh release view "${tag}" --json isDraft --jq .isDraft 2>/dev/null || echo missing)"
  if [ "${draft}" = false ]; then
    continue
  fi
  if [ "${draft}" = missing ]; then
    mapfile -t cliff < <(jq -r "${cliff_args}" <<<"${product}")
    notes="$(git-cliff --config tools/workflows/release/cliff.toml "${cliff[@]}" --latest --strip all)"
    gh release create "${tag}" --draft --verify-tag \
      --title "${project} v${version}" --notes "${notes}"
  fi
  matrix="$(jq -c --argjson product "${product}" --arg tag "${tag}" --arg version "${version}" \
    '. + [$product + {tag: $tag, version: $version} | del(.paths)]' <<<"${matrix}")"
done
echo "matrix=${matrix}" >> "${GITHUB_OUTPUT}"
echo "Release matrix: ${matrix}"
