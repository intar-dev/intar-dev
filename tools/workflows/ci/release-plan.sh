#!/usr/bin/env bash
# ci.yml, job release-plan, step "Plan the release dry run".
# The products this change would release: each whose manifest version differs
# from the base, or every product when the release build itself changed.
# release-dry-run builds them with release.yml's build steps and publishes
# nothing, so this needs no token and tags nothing. A pull request dry-runs
# only a change to the release build: the merge queue dry-runs a version
# change, such as the release pull request that is rebuilt after every merge.
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
mapfile -t product_list < <(jq -c '.[]' tools/workflows/release/products.json)
all=false
# The merge queue reruns a tooling change's dry run only when it reruns the
# rust lane (RECHECK), whose inputs hold the release build and every product:
# otherwise the pull request's run dry-ran the same inputs.
if ! git diff --quiet "${base}" HEAD -- "${tooling[@]}" &&
  { [ "${GITHUB_EVENT_NAME:-}" != merge_group ] || [ "${RECHECK:-true}" = true ]; }; then
  all=true
elif [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
  product_list=()
fi
manifest_version() {
  sed -n 's/^version = "\([^"]*\)".*/\1/p' | head -n 1
}
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
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "matrix=${matrix}" >> "${GITHUB_OUTPUT}"
fi
echo "Release dry run: ${matrix}"
