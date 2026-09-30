#!/usr/bin/env bash
# ci.yml, job release-plan, step "Plan the release dry run".
# The products this pull request would release: each whose manifest version
# differs from the base, or every product when the release build itself
# changed. release-dry-run builds them with release.yml's build steps and
# publishes nothing, so this needs no token and tags nothing.
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
all=false
if ! git diff --quiet "${base}" HEAD -- "${tooling[@]}"; then
  all=true
fi
manifest_version() {
  sed -n 's/^version = "\([^"]*\)".*/\1/p' | head -n 1
}
mapfile -t product_list < <(jq -c '.[]' tools/workflows/release/products.json)
matrix='[]'
for product in "${product_list[@]}"; do
  manifest="$(jq -r .manifest <<<"${product}")"
  version="$(manifest_version <"${manifest}")"
  before="$(git show "${base}:${manifest}" 2>/dev/null | manifest_version || true)"
  if [ "${all}" = false ] && [ "${version}" = "${before}" ]; then
    continue
  fi
  matrix="$(jq -c --argjson product "${product}" --arg version "${version}" \
    '. + [$product + {tag: "\($product.prefix)/v\($version)", version: $version} | del(.paths)]' <<<"${matrix}")"
done
echo "matrix=${matrix}" >> "${GITHUB_OUTPUT:-/dev/stdout}"
