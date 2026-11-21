#!/usr/bin/env bash
# qemu.yml, job build, step "Boot a guest"; also run by hand after build.sh.
# Boots the pinned guest kernel with the QEMU that build.sh just packed, the
# way zpm starts it, and passes when the guest's initramfs finds its virtio
# disk. That covers the emulator, the accelerator, the virtio disk on a qcow2
# overlay made by qemu-img, the user-mode network and the serial log.
# With a directory as its argument it boots with the QEMU in that directory
# instead, such as the `Contents/Helpers` of the app's bundle.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
case "$(uname -sm)" in
  "Darwin arm64") os=macos arch=arm64 system=qemu-system-aarch64 machine="virt,highmem=on" console=ttyAMA0 kernel_arch=arm64 ;;
  *) echo "No QEMU boot test is defined for $(uname -sm) yet." >&2; exit 1 ;;
esac
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
if [ $# -gt 0 ]; then
  bin="$(cd "$1" && pwd)"
else
  tar -xzf "${root}/dist/intar-qemu_${os}_${arch}.tar.gz" -C "${work}"
  bin="${work}/qemu/bin"
fi

# The guest kernel every image boots, by the pins image builds use.
kernel_rs="${root}/crates/intar-image-build/src/kernel.rs"
kernel_set="$(sed -nE 's/^pub const KERNEL_ARTIFACT_SET: &str = "([0-9a-f]{12})";$/\1/p' "${kernel_rs}")"
kernel_pin="$(grep -A1 "^const KERNEL_ARTIFACT_SHA256_$(tr '[:lower:]' '[:upper:]' <<< "${kernel_arch}"): &str =" "${kernel_rs}" | sed -nE 's/^ *"([0-9a-f]{64})";$/\1/p')"
[[ "${kernel_set}" =~ ^[0-9a-f]{12}$ && "${kernel_pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "Could not read the kernel pins from kernel.rs." >&2; exit 1; }
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error --output "${work}/kernel.tar.gz" \
  "https://github.com/intar-dev/intar-dev/releases/download/kernel%2Fv${kernel_set}/intar-kernel_${kernel_arch}.tar.gz"
[ "$(sha256 "${work}/kernel.tar.gz")" = "${kernel_pin}" ] || { echo "The downloaded kernel is not the pinned one." >&2; exit 1; }
mkdir "${work}/kernel"
tar -xzf "${work}/kernel.tar.gz" -C "${work}/kernel"

"${bin}/qemu-img" create -q -f raw "${work}/base.raw" 64M
"${bin}/qemu-img" create -q -f qcow2 -F raw -b "${work}/base.raw" "${work}/root.qcow2"

# HVF where the computer offers it; a hosted runner is itself a virtual
# machine and may not, and then the guest is emulated.
boot() {
  local accel="$1" cpu="$2" seconds="$3"
  : > "${work}/serial.log"
  "${bin}/${system}" -M "${machine}" -accel "${accel}" -cpu "${cpu}" -smp 2 -m 512 \
    -nodefaults -display none -no-reboot \
    -kernel "${work}/kernel/vmlinuz" -initrd "${work}/kernel/initrd.img" \
    -append "root=/dev/vda rw console=${console}" \
    -drive "if=none,id=disk0,file=${work}/root.qcow2,format=qcow2" -device virtio-blk-pci,drive=disk0,addr=0x3 \
    -netdev user,id=net0,restrict=on -device virtio-net-pci,netdev=net0,addr=0x4,romfile= \
    -serial "file:${work}/serial.log" > "${work}/qemu.log" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "${pid}" 2> /dev/null && [ "${waited}" -lt "${seconds}" ]; do
    if grep -q 'intar-initramfs: /dev/vda is present' "${work}/serial.log"; then
      kill "${pid}" 2> /dev/null || true
      wait "${pid}" 2> /dev/null || true
      echo "${accel} ${waited}"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  kill "${pid}" 2> /dev/null || true
  wait "${pid}" 2> /dev/null || true
  grep -q 'intar-initramfs: /dev/vda is present' "${work}/serial.log" && { echo "${accel} ${waited}"; return 0; }
  return 1
}
result=""
if [ "$(/usr/sbin/sysctl -n kern.hv_support 2> /dev/null)" = 1 ]; then
  result="$(boot hvf host 60)" || true
fi
[ -n "${result}" ] || result="$(boot "tcg,thread=multi" max 300)" || {
  echo "The guest did not reach its initramfs with this QEMU." >&2
  tail -n 30 "${work}/qemu.log" "${work}/serial.log" >&2
  exit 1
}
read -r accel seconds <<< "${result}"
echo "The guest found its disk after ${seconds} s (${accel})."
grep 'intar-initramfs' "${work}/serial.log" | head -n 3
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf -- '- boot test: guest kernel %s found its virtio disk after %s s (%s)\n' "${kernel_set}" "${seconds}" "${accel}" >> "${GITHUB_STEP_SUMMARY}"
fi
