#!/usr/bin/env bash
# kernel.yml, job publish, step "Publish the kernel release".
# dist/ holds both architectures' files and their checksums. A set is
# published once: its tag cannot be moved or deleted (the release-tags
# ruleset), and a set that is already published must hold these exact bytes.
set -euo pipefail
[[ "${TAG}" =~ ^kernel/v[0-9a-f]{12}$ ]]
mapfile -t assets < <(find dist -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
test "${#assets[@]}" -eq 3
for asset in "${assets[@]}"; do
  [[ "${asset}" =~ ^intar-kernel_[a-z0-9]+(\.tar\.gz|\.txt)$ ]] || { echo "Unexpected file: ${asset}" >&2; exit 1; }
done
same_as_dist() {
  local verify
  verify="$(mktemp -d)"
  gh release download "${TAG}" --dir "${verify}"
  diff <(cd dist && sha256sum -- * | LC_ALL=C sort) <(cd "${verify}" && sha256sum -- * | LC_ALL=C sort)
}

state="$(gh release view "${TAG}" --json isDraft --jq .isDraft 2>/dev/null || echo none)"
if [ "${state}" = false ]; then
  same_as_dist || { echo "${TAG} is published with other bytes; these inputs did not reproduce it." >&2; exit 1; }
  printf '%s is already published with exactly these files.\n' "${TAG}" >> "${GITHUB_STEP_SUMMARY}"
  exit 0
fi
# A draft left by a failed run is replaced by this build.
if [ "${state}" = true ]; then
  gh release delete "${TAG}" --yes
fi
gh release create "${TAG}" --draft --latest=false --target "${GITHUB_SHA}" \
  --title "Guest kernel ${TAG#kernel/v}" \
  --notes "The guest kernels of kernel set ${TAG#kernel/v}, built by kernel.yml from ${GITHUB_SHA}. Image builds download them by the checksums pinned in crates/intar-image-build/src/kernel.rs." \
  "${assets[@]/#/dist/}"
same_as_dist
gh release edit "${TAG}" --draft=false --latest=false
test "$(gh release view "${TAG}" --json isDraft --jq .isDraft)" = false
{
  printf 'Published %s. Pin these in crates/intar-image-build/src/kernel.rs:\n\n' "${TAG}"
  sed 's/^/    /' dist/intar-kernel_checksums.txt
} >> "${GITHUB_STEP_SUMMARY}"
