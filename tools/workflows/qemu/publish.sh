#!/usr/bin/env bash
# qemu.yml, job publish, step "Publish the QEMU release".
# dist/ holds each target's archive, the sources they were built from and the
# checksums. A set is published once: its tag cannot be moved or deleted (the
# release-tags ruleset). A second build of the same set is not expected to
# give the same bytes, so a published set is never replaced.
set -euo pipefail
[[ "${TAG}" =~ ^qemu/v[0-9a-f]{12}$ ]]
mapfile -t assets < <(find dist -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
for asset in "${assets[@]}"; do
  [[ "${asset}" =~ ^intar-qemu_[a-z0-9_]+(\.tar\.gz|\.tar|\.txt)$ ]] || { echo "Unexpected file: ${asset}" >&2; exit 1; }
done
test -f dist/intar-qemu_sources.tar -a -f dist/intar-qemu_checksums.txt

state="$(gh release view "${TAG}" --json isDraft --jq .isDraft 2>/dev/null || echo none)"
if [ "${state}" = false ]; then
  echo "${TAG} is already published. Its files stay as they are; change the sources or the build script for a new set." >&2
  exit 1
fi
# A draft left by a failed run is replaced by this build.
if [ "${state}" = true ]; then
  gh release delete "${TAG}" --yes
fi
gh release create "${TAG}" --draft --latest=false --target "${GITHUB_SHA}" \
  --title "App QEMU ${TAG#qemu/v}" \
  --notes "The QEMU the desktop app ships, set ${TAG#qemu/v}, built by qemu.yml from ${GITHUB_SHA}. intar-qemu_sources.tar holds the exact sources and the build script: QEMU is GPL-2.0, glib LGPL-2.1-or-later, and each archive carries the licence texts. The app's tooling takes an archive by the checksum pinned in tools/workflows/qemu/pins.txt." \
  "${assets[@]/#/dist/}"
verify="$(mktemp -d)"
gh release download "${TAG}" --dir "${verify}"
diff <(cd dist && sha256sum -- * | LC_ALL=C sort) <(cd "${verify}" && sha256sum -- * | LC_ALL=C sort)
gh release edit "${TAG}" --draft=false --latest=false
test "$(gh release view "${TAG}" --json isDraft --jq .isDraft)" = false
{
  printf 'Published %s. Pin these in tools/workflows/qemu/pins.txt:\n\n' "${TAG}"
  sed 's/^/    /' dist/intar-qemu_checksums.txt
} >> "${GITHUB_STEP_SUMMARY}"
