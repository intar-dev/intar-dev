#!/usr/bin/env bash
# kernel.yml, job pin, step "Pin the published kernels and open the pull request".
# The release kernel/v<set> holds the two kernels this run built and booted.
# Their checksums, the set and the platform digest that follows from them go
# into the source, and that change, with the bumped pins, becomes the pull
# request updates/kernel.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[[ "${TAG}" =~ ^kernel/v[0-9a-f]{12}$ ]]
sums="${RUNNER_TEMP}/kernel-pin"
rm -rf "${sums}"
gh release download "${TAG}" --pattern intar-kernel_checksums.txt --dir "${sums}"
amd64="$(sed -nE 's/^([0-9a-f]{64})  intar-kernel_amd64\.tar\.gz$/\1/p' "${sums}/intar-kernel_checksums.txt")"
arm64="$(sed -nE 's/^([0-9a-f]{64})  intar-kernel_arm64\.tar\.gz$/\1/p' "${sums}/intar-kernel_checksums.txt")"
python3 "${here}/pin.py" "${amd64}" "${arm64}"
cargo fmt -p intar-image-build -- --check
cargo test --locked --quiet -p intar-image-build

version="$(jq -er .version "${RUNNER_TEMP}/kernel-bump/latest.json")"
body="${RUNNER_TEMP}/kernel-pin-body.md"
{
  # Backticks are Markdown here, so they come in as arguments.
  tick='`' fence='```'
  printf 'Debian has the kernel source %s%s%s. This moves the guest kernel to %s%s%s, set %s%s%s.\n\n' \
    "${tick}" "${version}" "${tick}" "${tick}" "${KERNEL_RELEASE}" "${tick}" "${tick}" "${TAG#kernel/v}" "${tick}"
  printf 'kernel.yml compiled it for both architectures, booted each to user space on a virtio disk, and published them as [%s](https://github.com/%s/releases/tag/%s) with build provenance. This pull request pins that release.\n\n' \
    "${TAG}" "${GITHUB_REPOSITORY}" "${TAG/\//%2F}"
  printf '%s\n' "${fence}"
  cat "${sums}/intar-kernel_checksums.txt"
  printf '%s\n\n' "${fence}"
  printf '**What merging does.** The kernel is part of every image, so this releases the builder, and once that builder is rolled out every lab is rebuilt on its next publish and waits for verify and promote again. Merge it when that is wanted, not because it is green.\n'
} > "${body}"
tools/workflows/pins/open-pr.sh updates/kernel "build(intar-image-build): move the guest kernel to ${version}" "${body}" \
  crates/intar-image-build/src
