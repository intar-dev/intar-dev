#!/usr/bin/env bash
# release.yml, job publish, step "Publish tagged GitHub release".
set -euo pipefail
test "$(git cat-file -t "refs/tags/${TAG}")" = tag
git merge-base --is-ancestor "${TAG}^{commit}" origin/main
test "$(gh release view "${TAG}" --json isDraft --jq .isDraft)" = true
mapfile -t assets < <(find dist -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
test "${#assets[@]}" -gt 0
for asset in "${assets[@]}"; do
  [[ "${asset}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Unsafe release asset name: ${asset}" >&2; exit 1; }
done
# A draft left by a failed run is refilled from this build.
gh release view "${TAG}" --json assets --jq '.assets[].name' | while IFS= read -r stale; do
  gh release delete-asset "${TAG}" "${stale}" --yes </dev/null
done
gh release upload "${TAG}" "${assets[@]/#/dist/}"
verify="$(mktemp -d)"
gh release download "${TAG}" --dir "${verify}"
diff <(cd dist && sha256sum -- * | LC_ALL=C sort) <(cd "${verify}" && sha256sum -- * | LC_ALL=C sort)
gh release edit "${TAG}" --draft=false
test "$(gh release view "${TAG}" --json isDraft,isPrerelease,name --jq '[.isDraft, .isPrerelease, .name] | @json')" = "$(jq -cn --arg title "${TITLE}" '[false, false, $title]')"
