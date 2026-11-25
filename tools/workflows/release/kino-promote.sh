#!/usr/bin/env bash
# release.yml, job kino, step "Push the Kino artifact".
# Stores the Kino artifacts of a published kino release in the registry, one
# per guest architecture, as the publish token: the config blob, the binary and
# the manifest. KINO_VERSION names the release; without it, the newest
# published one. The website deploy pins only a Kino whose artifact is stored
# (tools/workflows/website/pin-releases.sh), so a release reaches new VMs once
# this ran and the website deployed. Storing again is harmless. A Kino release
# that keeps the guest contract needs no drain: running VMs keep their Kino,
# new ones get the pinned one.
set -euo pipefail
if [ -z "${KINO_VERSION:-}" ]; then
  KINO_VERSION="$(gh release list --repo "${GITHUB_REPOSITORY}" --limit 1000 --exclude-drafts --exclude-pre-releases \
    --json tagName --jq '.[].tagName | select(test("^kino/v[0-9]+\\.[0-9]+\\.[0-9]+$")) | ltrimstr("kino/v")' |
    sort -V | tail -n 1)"
fi
[[ "${KINO_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "kino_version must be X.Y.Z" >&2; exit 1; }
test -n "${INTAR_IMAGE_PUBLISH_TOKEN}"
tag="kino/v${KINO_VERSION}"
work="${RUNNER_TEMP}/kino-promote"
mkdir -p "${work}"
# Hosts run x86_64 guests; a learner's own computer may run arm64 ones.
architectures=(amd64 arm64)

# The release workflow built and attested the archives.
gh release download "${tag}" --repo "${GITHUB_REPOSITORY}" --dir "${work}" \
  --pattern "kino_${KINO_VERSION}_linux_*.tar.gz" --pattern "kino_${KINO_VERSION}_checksums.txt"
(cd "${work}" && sha256sum --check --strict "kino_${KINO_VERSION}_checksums.txt")
git fetch --quiet --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}"
contract="$(git show "${tag}:crates/intar-contracts/src/guest.rs" \
  | sed -n 's/^pub const GUEST_CONTRACT: u32 = \([1-9][0-9]*\);$/\1/p')"
[ -n "${contract}" ] || { echo "${tag} names no guest contract" >&2; exit 1; }
for arch in "${architectures[@]}"; do
  archive="kino_${KINO_VERSION}_linux_${arch}.tar.gz"
  gh attestation verify "${work}/${archive}" --repo "${GITHUB_REPOSITORY}"
  mkdir -p "${work}/${arch}"
  tar -xzf "${work}/${archive}" -C "${work}/${arch}" ./kino
  bun tools/deploy/kino-artifact.ts build --binary "${work}/${arch}/kino" --version "${KINO_VERSION}" \
    --guest-contract "${contract}" --architecture "${arch}" --out "${work}/${arch}/artifact" > "${work}/${arch}/artifact.json"
done

registry="${REGISTRY_URL}"
session="$(curl --fail-with-body --silent --show-error --retry 3 \
  --request POST \
  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{"intent":"kino-promote"}' \
  "${registry}/upload-sessions" | jq -er .session_id)"
complete() {
  curl --fail-with-body --silent --show-error --retry 3 \
    --request POST \
    --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
    --header "X-Intar-Registry-Session: ${session}" \
    --header "Content-Type: application/json" \
    --data "{\"outcome\":\"$1\"}" \
    "${registry}/upload-sessions/complete" > /dev/null
}
trap 'complete abandoned || true' EXIT
put() {
  local kind="$1" digest="$2" file="$3" type="$4"
  curl --fail-with-body --silent --show-error --retry 3 \
    --request PUT \
    --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \
    --header "X-Intar-Registry-Session: ${session}" \
    --header "Content-Type: ${type}" \
    --data-binary "@${file}" \
    "${registry}/${kind}/${digest}" > /dev/null
}
for arch in "${architectures[@]}"; do
  put blobs "$(jq -er .config.digest "${work}/${arch}/artifact.json")" "${work}/${arch}/artifact/config.json" application/octet-stream
  put blobs "$(jq -er .binary.digest "${work}/${arch}/artifact.json")" "${work}/${arch}/kino" application/octet-stream
  put manifests "$(jq -er .digest "${work}/${arch}/artifact.json")" "${work}/${arch}/artifact/manifest.json" application/vnd.oci.image.manifest.v1+json
done
trap - EXIT
complete published

for arch in "${architectures[@]}"; do
  printf 'Stored %s kino %s for guest contract %s as %s.\n' "${arch}" "${KINO_VERSION}" "${contract}" \
    "$(jq -er .digest "${work}/${arch}/artifact.json")" >> "${GITHUB_STEP_SUMMARY}"
done
