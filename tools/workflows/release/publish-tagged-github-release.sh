#!/usr/bin/env bash
# release.yml, job publish, step "Publish tagged GitHub release".
set -euo pipefail
# A new version is tagged only now, once its build passed. The product's latest
# tag must come before it, in history and by version, so a stale re-run of an
# older run never publishes a version below one already out. A re-run of this
# job after the tag was pushed finds it and goes on.
if [ "${CREATE_TAG}" = true ] && ! git rev-parse --quiet --verify "refs/tags/${TAG}" >/dev/null; then
  prefix="${TAG%/v*}"
  latest="$(git tag --list "${prefix}/v*" | { grep -E "^${prefix}/v[0-9]+\.[0-9]+\.[0-9]+$" || true; } | sort -V | tail -n 1)"
  test -n "${latest}"
  git merge-base --is-ancestor "${latest}^{commit}" "${REF}" ||
    { echo "${latest} is not an ancestor of ${REF}; refusing ${TAG}." >&2; exit 1; }
  [ "$(printf '%s\n%s\n' "${latest#"${prefix}/v"}" "${VERSION}" | sort -V | tail -n 1)" = "${VERSION}" ] &&
    [ "${latest}" != "${TAG}" ] ||
    { echo "${TAG} is not above ${latest}; refusing it." >&2; exit 1; }
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  gh auth setup-git --hostname github.com
  git tag -a "${TAG}" "${REF}" -m "${TITLE}"
  git push origin "refs/tags/${TAG}"
fi
test "$(git cat-file -t "refs/tags/${TAG}")" = tag
test "$(git rev-parse "${TAG}^{commit}")" = "${REF}"
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
