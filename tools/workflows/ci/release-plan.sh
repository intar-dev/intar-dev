#!/usr/bin/env bash
# ci.yml, job release-plan, step "Plan the release dry run".
# Every product, at its manifest version, when the release build itself
# changed; nothing otherwise. release-dry-run builds them with release.yml's
# build steps and publishes nothing, so this needs no token and tags nothing.
# No pull request changes a version: release.yml versions each release from
# its tags.
# Outside GitHub Actions the base is the merge base with origin/main, and the
# matrix goes to stdout.
set -euo pipefail
base="${BASE_SHA:-$(git merge-base origin/main HEAD)}"
# changes read its base from the merge checkout or fetched the event's base
# sha; this job has its own checkout.
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --quiet --no-tags --depth=1 origin "${base}"
fi
# The files the release build runs besides the products' own sources.
tooling=(
  tools/workflows/release/
  tools/image-build/
  ci/workflows/release.cue
  .github/actions/setup-rust/
  rust-toolchain.toml
)
matrix='[]'
# The merge queue reruns a tooling change's dry run only when it reruns the
# rust lane (RECHECK), whose inputs hold the release build and every product:
# otherwise the pull request's run dry-ran the same inputs.
if ! git diff --quiet "${base}" HEAD -- "${tooling[@]}" &&
  { [ "${GITHUB_EVENT_NAME:-}" != merge_group ] || [ "${RECHECK:-true}" = true ]; }; then
  mapfile -t product_list < <(jq -c '.[]' tools/workflows/release/products.json)
  for product in "${product_list[@]}"; do
    version="$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$(jq -r .manifest <<<"${product}")" | head -n 1)"
    matrix="$(jq -c --argjson product "${product}" --arg version "${version}" \
      '. + [$product + {tag: "\($product.prefix)/v\($version)", version: $version} | del(.paths)]' <<<"${matrix}")"
  done
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "matrix=${matrix}" >> "${GITHUB_OUTPUT}"
fi
echo "Release dry run: ${matrix}"
