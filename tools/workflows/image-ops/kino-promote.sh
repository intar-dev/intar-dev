#!/usr/bin/env bash
# image-ops workflow, kino job, "Push the Kino artifact" step.
# Stores the Kino artifact of a published kino release in the registry, as
# the publish token: the config blob, the binary and the manifest whose digest
# the release workflow wrote into tools/deploy/kino-pin.json. The Worker counts
# that pin only once this artifact is stored, so this runs before the pin pull
# request merges. A Kino release that keeps the guest contract needs no drain:
# running VMs keep their Kino, new ones get the pinned one.
set -euo pipefail
[[ "${KINO_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "kino_version must be X.Y.Z" >&2; exit 1; }
test -n "${INTAR_IMAGE_PUBLISH_TOKEN}"
tag="kino/v${KINO_VERSION}"
archive="kino_${KINO_VERSION}_linux_amd64.tar.gz"
work="${RUNNER_TEMP}/kino-promote"
mkdir -p "${work}"

# Guest VMs are x86_64. The release workflow built and attested the archive.
gh release download "${tag}" --repo "${GITHUB_REPOSITORY}" --dir "${work}" \
  --pattern "${archive}" --pattern "kino_${KINO_VERSION}_checksums.txt"
(cd "${work}" && sha256sum --check --strict --ignore-missing "kino_${KINO_VERSION}_checksums.txt")
gh attestation verify "${work}/${archive}" --repo "${GITHUB_REPOSITORY}"
tar -xzf "${work}/${archive}" -C "${work}" ./kino
git fetch --quiet --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}"
contract="$(git show "${tag}:crates/intar-contracts/src/guest.rs" \
  | sed -n 's/^pub const GUEST_CONTRACT: u32 = \([1-9][0-9]*\);$/\1/p')"
[ -n "${contract}" ] || { echo "${tag} names no guest contract" >&2; exit 1; }
bun tools/deploy/kino-artifact.ts build --binary "${work}/kino" --version "${KINO_VERSION}" \
  --guest-contract "${contract}" --out "${work}/artifact" > "${work}/artifact.json"
digest="$(jq -er .digest "${work}/artifact.json")"

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
put blobs "$(jq -er .config.digest "${work}/artifact.json")" "${work}/artifact/config.json" application/octet-stream
put blobs "$(jq -er .binary.digest "${work}/artifact.json")" "${work}/kino" application/octet-stream
put manifests "${digest}" "${work}/artifact/manifest.json" application/vnd.oci.image.manifest.v1+json
trap - EXIT
complete published

pinned="$(jq -r --arg contract "${contract}" '.[$contract].current // empty' tools/deploy/kino-pin.json 2>/dev/null || true)"
{
  printf 'Stored kino %s for guest contract %s as %s.\n' "${KINO_VERSION}" "${contract}" "${digest}"
  if [ "${pinned}" = "${digest}" ]; then
    printf 'main already pins it; the next website deploy serves it.\n'
  else
    printf 'main pins %s; merge the website pin pull request to serve this one.\n' "${pinned:-nothing}"
  fi
} >> "${GITHUB_STEP_SUMMARY}"
