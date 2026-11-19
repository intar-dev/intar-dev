#!/usr/bin/env bash
# `cuenv task jumper-qemu`: puts the app's pinned QEMU beside a development
# build of the app (target/<profile>/qemu), where the app looks for it. The
# archive comes from the release qemu/v<set> and must have the pinned SHA-256.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
profile="${1:-debug}"
case "$(uname -sm)" in
  "Darwin arm64") os=macos arch=arm64 ;;
  *) echo "No QEMU is published for $(uname -sm) yet." >&2; exit 1 ;;
esac
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi | cut -d' ' -f1; }
set_id="$(sed -n 's/^set //p' "${here}/pins.txt")"
pin="$(sed -n "s/^${os} ${arch} //p" "${here}/pins.txt")"
[[ "${set_id}" =~ ^[0-9a-f]{12}$ && "${pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "pins.txt names no QEMU for ${os} ${arch}." >&2; exit 1; }
# The pinned set must be the one these sources build.
built="$(bash "${here}/set.sh")"
[ "${built}" = "${set_id}" ] || { echo "pins.txt pins QEMU set ${set_id}, but the sources build ${built}: qemu.yml publishes that set and opens the pull request that pins it." >&2; exit 1; }

file="intar-qemu_${os}_${arch}.tar.gz"
cache="${root}/target/qemu/${set_id}"
mkdir -p "${cache}"
[ -f "${cache}/${file}" ] && [ "$(sha256 "${cache}/${file}")" = "${pin}" ] ||
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error --output "${cache}/${file}" \
    "https://github.com/intar-dev/intar-dev/releases/download/qemu%2Fv${set_id}/${file}"
[ "$(sha256 "${cache}/${file}")" = "${pin}" ] || { echo "${file} of qemu/v${set_id} is not the pinned file." >&2; exit 1; }
place="${root}/target/${profile}"
mkdir -p "${place}"
rm -rf "${place}/qemu"
tar -xzf "${cache}/${file}" -C "${place}"
echo "The app's QEMU ${set_id} is in ${place}/qemu."
