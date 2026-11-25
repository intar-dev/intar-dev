#!/usr/bin/env bash
# ci.yml, job release-plan, step "Plan the release dry run".
# The products a pull request's change to the release build reaches, at their
# manifest versions: a script one product's build alone runs dry-runs that
# product, any other file of the build every product. Plan and publish steps
# the build never runs dry-run nothing; tools/ci tests them. release-dry-run
# builds with release.yml's build steps and publishes nothing, so this needs
# no token and tags nothing.
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
release=tools/workflows/release
projects=()
while IFS= read -r file; do
  case "${file}" in
    # Only release.yml's plan and publish jobs run these.
    "${release}"/plan-release.sh | "${release}"/publish-tagged-github-release.sh | "${release}"/kino-promote.sh | \
      "${release}"/cliff.toml | "${release}"/deps-commits.py | "${release}"/push-bot-branch.sh) ;;
    "${release}"/build-jumper-macos.sh | "${release}"/setup-macos-signing.sh) projects+=(intar-desktop) ;;
    "${release}"/smoke-test-image-cli-package.sh) projects+=(intar-image-cli) ;;
    "${release}"/privileged-agent-package-smoke.sh | "${release}"/preflight-jailed-release-runner.sh) projects+=(intar-agent) ;;
    *) projects=(all); break ;;
  esac
done < <(git diff --name-only "${base}" HEAD -- "${tooling[@]}")
matrix='[]'
mapfile -t product_list < <(jq -c '.[]' "${release}/products.json")
for product in "${product_list[@]}"; do
  project="$(jq -r .project <<<"${product}")"
  [[ " ${projects[*]} " == *" all "* || " ${projects[*]} " == *" ${project} "* ]] || continue
  version="$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$(jq -r .manifest <<<"${product}")" | head -n 1)"
  matrix="$(jq -c --argjson product "${product}" --arg version "${version}" \
    '. + [$product + {tag: "\($product.prefix)/v\($version)", version: $version} | del(.paths)]' <<<"${matrix}")"
done
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "matrix=${matrix}" >> "${GITHUB_OUTPUT}"
fi
echo "Release dry run: ${matrix}"
