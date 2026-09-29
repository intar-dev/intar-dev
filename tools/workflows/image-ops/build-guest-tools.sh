#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Build guest Kino and tools disk" step.
set -euo pipefail
cargo zigbuild --locked --manifest-path "${RUNNER_TEMP}/kino-source/Cargo.toml" \
  --target-dir "${RUNNER_TEMP}/kino-target" \
  -p kino --profile guest --target x86_64-unknown-linux-musl
cp "${RUNNER_TEMP}/kino-target/x86_64-unknown-linux-musl/guest/kino" "${TOOLS_DIR}/kino"
tools/image-build/with-libnbd-env.sh -- cargo build --locked -p intar-image-cli
target/debug/intar-image-cli build-guest-tools \
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
