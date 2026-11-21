#!/usr/bin/env bash
# kernel.yml and the weekly kernel update job, step "Boot the kernel".
# Boots the freshly built dist/intar-kernel_${KERNEL_ARCH}.tar.gz on a runner
# of that architecture and proves it reaches user space on a virtio disk: the
# archive's own initramfs mounts /dev/vda and hands over to an /sbin/init that
# prints a marker with `uname -r` and powers the machine off. The release in
# that marker must be the one the archive's kernel-build.json records.
#
# QEMU runs in the pinned Debian image the kernel was built in, installed from
# a dated snapshot, like the build itself: the runner's own packages float, and
# every apt install of a workflow step is pinned (check-workflow-security).
# The script runs twice: on the runner, and with --in-container in that image.
set -euo pipefail

marker=INTAR-KERNEL-SMOKE-OK
# The versions below are the ones of this snapshot's trixie suite. A snapshot
# never changes, so this pair moves only when someone wants a newer QEMU.
snapshot=20261105T000000Z
ca=/etc/ssl/certs/ca-certificates.crt

in_container() {
  local arch="${KERNEL_ARCH}" qemu machine console accel cpu started status=0

  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
  cat > /etc/apt/sources.list <<EOF_APT
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${snapshot}/ trixie main
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${snapshot}/ trixie-updates main
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${snapshot}/ trixie-security main
EOF_APT
  # The image has no CA certificates of its own; the runner's were mounted.
  mkdir -p /etc/ssl/certs
  cp /smoke-ca.crt "${ca}"
  echo "Acquire::https::CaInfo \"${ca}\";" > /etc/apt/apt.conf.d/99intar-ca
  apt-get update -qq
  command -v mke2fs > /dev/null || apt-get install -qq -y --no-install-recommends e2fsprogs=1.47.2-3+b12
  case "${arch}" in
    amd64)
      apt-get install -qq -y --no-install-recommends cpio=2.15+dfsg-2 qemu-system-x86=1:10.0.13+ds-0+deb13u1
      qemu=qemu-system-x86_64 machine=q35 console=ttyS0
      ;;
    arm64)
      apt-get install -qq -y --no-install-recommends cpio=2.15+dfsg-2 qemu-system-arm=1:10.0.13+ds-0+deb13u1
      qemu=qemu-system-aarch64 machine=virt console=ttyAMA0
      ;;
  esac

  # The busybox the kernel's own initramfs runs is the root disk's only program.
  mkdir /work/initrd /work/root
  (cd /work/initrd && gzip -dc /work/kernel/initrd.img | cpio -id --quiet)
  test -x /work/initrd/bin/busybox
  # What intar-initramfs-init.sh needs of the disk: ext4, marked clean (or it
  # runs e2fsck -p first), /dev, /proc and /sys to move its mounts onto, and
  # /sbin/init to exec.
  mkdir -p /work/root/bin /work/root/sbin /work/root/dev /work/root/proc /work/root/sys
  cp /work/initrd/bin/busybox /work/root/bin/busybox
  cat > /work/root/sbin/init <<EOF_INIT
#!/bin/busybox sh
echo "${marker} \$(/bin/busybox uname -r)" > /dev/console
/bin/busybox sync
/bin/busybox poweroff -f
EOF_INIT
  chmod 0755 /work/root/sbin/init
  truncate -s 64M /work/root.img
  mke2fs -q -F -t ext4 -d /work/root /work/root.img

  if [ -w /dev/kvm ]; then accel=kvm cpu=host; else accel=tcg cpu=max; fi
  started="${SECONDS}"
  # panic=-1 with -no-reboot ends QEMU at once when the kernel panics; the
  # timeout is for an emulated boot that hangs.
  timeout 600 "${qemu}" \
    -M "${machine}" -accel "${accel}" -cpu "${cpu}" -smp 2 -m 1024 \
    -nodefaults -display none -no-reboot \
    -kernel /work/kernel/vmlinuz -initrd /work/kernel/initrd.img \
    -append "root=/dev/vda rw console=${console} panic=-1" \
    -drive if=none,id=root,file=/work/root.img,format=raw \
    -device virtio-blk-pci,drive=root \
    -serial file:/work/serial.log || status=$?
  echo "${accel} $((SECONDS - started)) ${status}" > /work/result
}

if [ "${1:-}" = --in-container ]; then
  in_container
  exit 0
fi

arch="${KERNEL_ARCH}"
case "$(uname -m)/${arch}" in
  x86_64/amd64 | aarch64/arm64) ;;
  *) echo "This $(uname -m) runner cannot boot the ${arch} kernel natively." >&2; exit 1 ;;
esac
work="${RUNNER_TEMP}/kernel-smoke"
rm -rf "${work}"
mkdir -p "${work}/kernel" "${work}/in"
tar -xzf "dist/intar-kernel_${arch}.tar.gz" -C "${work}/kernel"
release="$(jq -er .release "${work}/kernel/kernel-build.json")"
[[ "${release}" =~ ^[A-Za-z0-9._+-]+$ ]]
image="$(cargo run --locked --quiet -p intar-image-build --example kernel_inputs -- "${arch}" "${work}/in" | jq -er .debian_image)"

kvm=()
if [ -e /dev/kvm ]; then kvm=(--device /dev/kvm); fi
container=0
docker run --rm "${kvm[@]}" \
  --volume "${work}:/work" \
  --volume "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke.sh:/smoke.sh:ro" \
  --volume "${ca}:/smoke-ca.crt:ro" \
  --env KERNEL_ARCH="${arch}" \
  "${image}" bash /smoke.sh --in-container || container=$?

accel='' seconds='' qemu_status=''
if [ -f "${work}/result" ]; then read -r accel seconds qemu_status < "${work}/result"; fi
booted=''
if [ -f "${work}/serial.log" ]; then
  booted="$(grep -a -o -m 1 "${marker} [A-Za-z0-9._+-]*" "${work}/serial.log" | cut -d' ' -f2 || true)"
fi

if [ "${container}" -ne 0 ]; then
  outcome="failed: the container that runs QEMU exited ${container}"
elif [ -z "${booted}" ]; then
  outcome="failed: no ${marker} on the console (QEMU exited ${qemu_status:-?}; 124 is the timeout)"
elif [ "${booted}" != "${release}" ]; then
  outcome="failed: the kernel says it is ${booted}, kernel-build.json says ${release}"
else
  outcome=passed
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### %s kernel boot\n\n' "${arch}"
    printf -- '- result: %s\n- accelerator: %s\n- seconds: %s\n- release: %s\n' \
      "${outcome}" "${accel:-none}" "${seconds:-0}" "${booted:-none}"
  } >> "${GITHUB_STEP_SUMMARY}"
fi
echo "${arch} kernel boot ${outcome} (accelerator ${accel:-none}, ${seconds:-0} s, release ${booted:-none})"
if [ "${outcome}" != passed ]; then
  if [ -f "${work}/serial.log" ]; then
    echo '--- the end of the serial console ---' >&2
    tail -n 60 "${work}/serial.log" >&2
  fi
  exit 1
fi
