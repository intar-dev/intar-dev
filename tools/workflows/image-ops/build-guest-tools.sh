#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Build the tools disk from the releases" step.
# Nothing is compiled here: Kino is the guest build in its published release,
# and the disk is built by the image CLI release that the website pins.
set -euo pipefail
gh release view "${KINO_TAG}" --json isDraft,isPrerelease \
  | jq -e '.isDraft == false and .isPrerelease == false' >/dev/null
test "$(git cat-file -t "refs/tags/${KINO_TAG}")" = tag
source_sha="$(git rev-parse "refs/tags/${KINO_TAG}^{commit}")"
git merge-base --is-ancestor "${source_sha}" "${GITHUB_SHA}"
# release.yml builds a release from its tag, so the tag's build script tells
# whether the release is the guest build; older Kino releases are not.
if ! git show "${source_sha}:tools/workflows/release/build-release-artifacts.sh" 2>/dev/null \
  | grep -Fq 'profile=guest'; then
  echo "${KINO_TAG} predates the guest build; release a newer Kino first." >&2
  exit 1
fi

releases="${RUNNER_TEMP}/tool-releases"
mkdir -p "${releases}/image-cli"
kino_version="${KINO_TAG#kino/v}"
kino_archive="kino_${kino_version}_linux_amd64.tar.gz"
gh release download "${KINO_TAG}" --dir "${releases}" \
  --pattern "${kino_archive}" --pattern "kino_${kino_version}_checksums.txt"
(
  cd "${releases}"
  awk -v name="${kino_archive}" '$2 == name' "kino_${kino_version}_checksums.txt" \
    | sha256sum --check --strict
)
tar -xzf "${releases}/${kino_archive}" -C "${releases}" --no-same-owner ./kino

read -r cli_version cli_sha256 < <(python3 - <<'PY'
import json
import pathlib
import re

text = pathlib.Path("apps/web/wrangler.jsonc").read_text()


def pin(key):
    found = re.findall(rf'^\s*"{key}": ("(?:[^"\\]|\\.)*"),?$', text, re.MULTILINE)
    if len(found) != 1:
        raise SystemExit(f"apps/web/wrangler.jsonc must set {key} on exactly one line")
    return json.loads(found[0])


print(pin("SCENARIO_COMPILER_CLI_VERSION"), json.loads(pin("SCENARIO_COMPILER_CLI_SHA256"))["linux_amd64"])
PY
)
[[ "${cli_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${cli_sha256}" =~ ^[0-9a-f]{64}$ ]]
cli_archive="intar-image-cli_${cli_version}_linux_amd64.tar.gz"
gh release download "image-cli/v${cli_version}" --dir "${releases}" --pattern "${cli_archive}"
printf '%s  %s\n' "${cli_sha256}" "${releases}/${cli_archive}" | sha256sum --check --strict
tar -xzf "${releases}/${cli_archive}" -C "${releases}/image-cli" --no-same-owner

jq -n --arg tag "${KINO_TAG}" --arg source "${source_sha}" \
  --arg workflow "${GITHUB_SHA}" --arg image_cli "image-cli/v${cli_version}" \
  '{tag: $tag, source_sha: $source, workflow_sha: $workflow, image_cli: $image_cli, profile: "guest", target: "x86_64-unknown-linux-musl"}' \
  > "${TOOLS_DIR}/provenance.json"
cp "${releases}/kino" "${TOOLS_DIR}/kino"
"${releases}/image-cli/intar-image-cli" build-guest-tools \
  --kino-binary "${TOOLS_DIR}/kino" --output-root "${TOOLS_DIR}" \
  --mke2fs-binary /usr/sbin/mke2fs > "${TOOLS_DIR}/build.json"
jq 'del(.compressed_disk_path)' "${TOOLS_DIR}/build.json" > "${TOOLS_DIR}/candidate.json"
jq -e '.schema_version == 1 and .bootstrap_abi == 2' "${TOOLS_DIR}/candidate.json" >/dev/null
cd "${TOOLS_DIR}"
disk="$(jq -r .tools_disk_sha256 candidate.json)"
jq -r '"\(.kino_sha256)  kino", "\(.tools_disk_sha256)  \(.tools_disk_sha256).ext4", "\(.compressed_disk_sha256)  \(.tools_disk_sha256).ext4.zst"' \
  candidate.json > SHA256SUMS
sha256sum --check SHA256SUMS
zstd --decompress --stdout "${disk}.ext4.zst" | sha256sum | cut -d ' ' -f 1 | diff - <(printf '%s\n' "${disk}")
