#!/bin/sh
set -eu

# These are boot fixtures only. They are downloaded directly from their
# publishers into a root-only cache and are not redistributed in the Intar
# archive. Immutable digests make online and offline runs identical.
KERNEL_URL=https://github.com/cloud-hypervisor/linux/releases/download/ch-release-v6.16.9-20260508/vmlinux-x86_64
KERNEL_SHA256=9d3570b47d5abb069ca00edfbfcef4c68306a9c3d078a01f10082b258f1001b8
ALPINE_URL=https://dl-cdn.alpinelinux.org/alpine/v3.11/releases/x86_64/alpine-minirootfs-3.11.3-x86_64.tar.gz
ALPINE_SHA256=8a6c827f137058ac3e3df1125891ff5c3b62955f0b911adec26eae6ea2bbb285
CACHE_ROOT=/var/lib/intar/self-test-assets

die() {
  echo "intar-jailerd self-test: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 [--offline]" >&2
  exit 2
}

offline=false
case "$#:$*" in
  0:) ;;
  1:--offline) offline=true ;;
  *) usage ;;
esac

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ "$(uname -s)" = Linux ] || die "requires Linux"
[ "$(uname -m)" = x86_64 ] || die "requires x86_64"

for command in awk curl flock install mkfs.ext4 mkfs.vfat mktemp sha256sum stat systemctl systemd-run tar truncate; do
  command -v "${command}" >/dev/null 2>&1 || die "required command is missing: ${command}"
done
[ -x /usr/lib/intar/intar-jailerd ] || die "installed intar-jailerd is missing"
[ -f /etc/intar-jailerd/config.toml ] || die "jailerd configuration is missing"
if systemctl is-active --quiet intar-agent.service; then
  die "intar-agent.service must be stopped before the privileged self-test"
fi

socket_was_active=false
daemon_was_active=false
if systemctl is-active --quiet intar-jailerd.socket; then
  socket_was_active=true
fi
if systemctl is-active --quiet intar-jailerd.service; then
  daemon_was_active=true
fi
run_root=
self_test_unit=

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ -n "${self_test_unit}" ]; then
    systemctl stop "${self_test_unit}" >/dev/null 2>&1 || true
    systemctl reset-failed "${self_test_unit}" >/dev/null 2>&1 || true
  fi
  if [ -n "${run_root}" ]; then
    rm -rf -- "${run_root}"
  fi
  if [ "${socket_was_active}" = true ] && \
     ! systemctl start intar-jailerd.socket; then
    echo "intar-jailerd self-test: failed to restore intar-jailerd.socket" >&2
    status=1
  fi
  if [ "${daemon_was_active}" = true ] && \
     ! systemctl start intar-jailerd.service; then
    echo "intar-jailerd self-test: failed to restore intar-jailerd.service" >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup 0
trap 'exit 130' HUP INT TERM

# Freeze socket activation before the binary takes the maintenance lock. This
# also makes self-test safe after an earlier doctor invocation activated the
# persistent daemon.
systemctl stop intar-jailerd.socket
systemctl stop intar-jailerd.service
if systemctl is-active --quiet intar-jailerd.socket || \
   systemctl is-active --quiet intar-jailerd.service; then
  die "could not stop the jailerd socket/service boundary"
fi

umask 077
# Keep the shared Intar ancestor traversable for the narrowly scoped ACLs on
# production jail API/log paths. Only the self-test cache itself is root-only.
install -d -o root -g root -m 0755 /var/lib/intar
install -d -o root -g root -m 0700 "${CACHE_ROOT}"
install -d -o root -g root -m 0700 "${CACHE_ROOT}/downloads"
install -d -o root -g root -m 0700 "${CACHE_ROOT}/runs"
exec 8>"${CACHE_ROOT}/wrapper.lock"
chmod 0600 "${CACHE_ROOT}/wrapper.lock"
flock -x 8

for directory in "${CACHE_ROOT}" "${CACHE_ROOT}/downloads" "${CACHE_ROOT}/runs"; do
  metadata=$(stat -c '%u:%g:%a' "${directory}")
  [ "${metadata}" = 0:0:700 ] || \
    die "root cache must remain root:root mode 0700: ${directory} (${metadata})"
done

download_verified() {
  url=$1
  expected=$2
  destination=$3

  if [ -f "${destination}" ] && \
     echo "${expected}  ${destination}" | sha256sum --check --strict >/dev/null 2>&1; then
    return
  fi
  [ "${offline}" = false ] || \
    die "offline cache is missing or corrupt: ${destination}"

  temporary=$(mktemp "${CACHE_ROOT}/downloads/.download.XXXXXX")
  if ! curl \
    --fail \
    --location \
    --proto '=https' \
    --retry 3 \
    --show-error \
    --silent \
    --tlsv1.2 \
    --output "${temporary}" \
    "${url}"; then
    rm -f -- "${temporary}"
    die "download failed: ${url}"
  fi
  if ! echo "${expected}  ${temporary}" | sha256sum --check --strict >/dev/null; then
    rm -f -- "${temporary}"
    die "download digest mismatch: ${url}"
  fi
  chown root:root "${temporary}"
  chmod 0400 "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

kernel_download=${CACHE_ROOT}/downloads/vmlinux-x86_64
alpine_download=${CACHE_ROOT}/downloads/alpine-minirootfs.tar.gz
download_verified "${KERNEL_URL}" "${KERNEL_SHA256}" "${kernel_download}"
download_verified "${ALPINE_URL}" "${ALPINE_SHA256}" "${alpine_download}"

run_root=$(mktemp -d "${CACHE_ROOT}/runs/run.XXXXXX")
guest_root=${run_root}/guest-root
install -d -o root -g root -m 0700 "${guest_root}"

# The archive bytes are pinned, but validate names before root extracts them.
tar -tzf "${alpine_download}" | while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..)
      die "Alpine fixture contains an unsafe path: ${entry}"
      ;;
  esac
done
tar -xzf "${alpine_download}" \
  -C "${guest_root}" \
  --no-same-owner \
  --no-same-permissions

# Emit a deterministic boot marker, then keep one vCPU continuously busy so
# the privileged proof can observe eight independently throttled 125m VMs for
# one shared 30-second saturation window.
printf '%s\n' \
  '::sysinit:/bin/mount -t proc proc /proc' \
  '::sysinit:/bin/mount -t sysfs sysfs /sys' \
  '::sysinit:/bin/sh -c "echo INTAR_PACKAGE_SMOKE_READY >/dev/console"' \
  '::respawn:/bin/sh -c "while :; do :; done"' \
  'hvc0::respawn:/sbin/getty -L hvc0 115200 vt100' \
  '::ctrlaltdel:/sbin/reboot' \
  '::shutdown:/bin/umount -a -r' \
  > "${guest_root}/etc/inittab"
chmod 0644 "${guest_root}/etc/inittab"

install -o root -g root -m 0400 "${kernel_download}" "${run_root}/kernel"
truncate -s 256M "${run_root}/root.raw"
mkfs.ext4 -q -F -L intar-smoke-root -d "${guest_root}" "${run_root}/root.raw"
truncate -s 64M "${run_root}/runtime.raw"
mkfs.ext4 -q -F -L intar-smoke-runtime "${run_root}/runtime.raw"
truncate -s 64M "${run_root}/recordings.vfat"
mkfs.vfat -n INTARREC "${run_root}/recordings.vfat" >/dev/null
chown root:root \
  "${run_root}/root.raw" \
  "${run_root}/runtime.raw" \
  "${run_root}/recordings.vfat"
chmod 0600 \
  "${run_root}/root.raw" \
  "${run_root}/runtime.raw" \
  "${run_root}/recordings.vfat"

for fixture in kernel root.raw runtime.raw recordings.vfat; do
  metadata=$(stat -c '%u:%g:%a:%h' "${run_root}/${fixture}")
  case "${metadata}" in
    0:0:400:1|0:0:600:1) ;;
    *) die "self-test fixture has unsafe metadata: ${fixture} (${metadata})" ;;
  esac
done

kernel_sha256=$(sha256sum "${run_root}/kernel" | awk '{print $1}')
root_sha256=$(sha256sum "${run_root}/root.raw" | awk '{print $1}')
runtime_sha256=$(sha256sum "${run_root}/runtime.raw" | awk '{print $1}')
recording_sha256=$(sha256sum "${run_root}/recordings.vfat" | awk '{print $1}')
[ "${kernel_sha256}" = "${KERNEL_SHA256}" ] || die "cached kernel digest changed"

self_test_unit="intar-jailerd-selftest-$$.service"
# StopVm atomically exports each drained recording disk back into this exact
# root-owned disposable artifact directory before DestroyVm removes its jail.
systemd-run \
  --quiet \
  --wait \
  --pipe \
  --collect \
  --unit="${self_test_unit}" \
  --property=Type=exec \
  --property=User=root \
  --property=Group=root \
  --property=NoNewPrivileges=false \
  --property=UMask=0077 \
  --property=PrivateTmp=true \
  --property=ProtectHome=true \
  --property=ProtectSystem=strict \
  --property="ReadWritePaths=/var/lib/intar/jails /var/cache/intar-agent /run/intar-jailerd ${run_root}" \
  --property=ProtectClock=true \
  --property=ProtectControlGroups=true \
  --property=ProtectHostname=true \
  --property=ProtectKernelLogs=true \
  --property=ProtectKernelModules=true \
  --property=ProtectKernelTunables=false \
  --property=LockPersonality=true \
  --property=MemoryDenyWriteExecute=true \
  --property='RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6' \
  --property=RestrictSUIDSGID=false \
  --property=RestrictRealtime=true \
  --property=LimitRTPRIO=0 \
  --property=DevicePolicy=closed \
  --property='DeviceAllow=/dev/kvm rw' \
  --property='DeviceAllow=/dev/net/tun rw' \
  --property='DeviceAllow=/dev/urandom r' \
  --property='DeviceAllow=/dev/null rw' \
  --property='CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_MKNOD CAP_NET_ADMIN CAP_SETGID CAP_SETPCAP CAP_SETUID CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_RESOURCE' \
  --property=SystemCallArchitectures=native \
  --property='SystemCallFilter=@system-service @mount @privileged' \
  /usr/lib/intar/intar-jailerd self-test \
  --config /etc/intar-jailerd/config.toml \
  --kernel "${run_root}/kernel" \
  --kernel-sha256 "${kernel_sha256}" \
  --root-disk "${run_root}/root.raw" \
  --root-disk-sha256 "${root_sha256}" \
  --runtime-disk "${run_root}/runtime.raw" \
  --runtime-disk-sha256 "${runtime_sha256}" \
  --recording-disk "${run_root}/recordings.vfat" \
  --recording-disk-sha256 "${recording_sha256}"
self_test_unit=

echo "intar-jailerd self-test: eight-VM 125m saturation, ninth-admission rejection, and jailed Cloud Hypervisor lifecycle passed"
