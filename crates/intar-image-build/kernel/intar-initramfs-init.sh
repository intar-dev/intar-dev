#!/bin/busybox sh
# Intar cutover initramfs init.
#
# A standard busybox initramfs: a pinned static busybox, a pinned static
# e2fsck, and this script. It mounts the one known root device and hands over
# with busybox switch_root. There is no probe, no scan, no boot C, and no knob
# to skip a filesystem check.
#
# One control on the kernel command line:
#   intar.root_wait_ms=N   how long to wait for the root device; default 3000
#
# Every failure prints diagnostics and powers the machine off, so the harness
# sees a clean failure instead of a hang.

BB=/bin/busybox
PATH=/bin:/sbin:/usr/bin:/usr/sbin
export PATH

log() {
  echo "intar-initramfs: $*"
}

fatal() {
  echo "intar-initramfs: FATAL: $*" >&2
  $BB sync
  $BB poweroff -f
  while true; do $BB sleep 1; done
}

dump_devices() {
  log 'devices present:'
  for entry in /dev/*; do
    [ -e "$entry" ] || continue
    log "  $entry"
  done
}

$BB mount -t devtmpfs -o mode=0755 devtmpfs /dev || fatal 'cannot mount devtmpfs'
$BB mount -t proc proc /proc || fatal 'cannot mount proc'
$BB mount -t sysfs sysfs /sys || fatal 'cannot mount sysfs'

root=''
wait_ms=3000
for word in $($BB cat /proc/cmdline); do
  case "$word" in
    root=*) root="${word#root=}" ;;
    intar.root_wait_ms=*) wait_ms="${word#intar.root_wait_ms=}" ;;
  esac
done
cmdline="$($BB cat /proc/cmdline)"

case "$root" in
  /dev/*) ;;
  '') fatal 'the kernel command line has no root= value' ;;
  *) fatal "root $root is not a /dev device path" ;;
esac
name="${root#/dev/}"
case "$name" in
  '') fatal "root $root does not name a device" ;;
  */*) fatal "root $root needs a device resolver; use a direct /dev name root" ;;
  *:*) fatal "root $root looks like a network root; this profile mounts a local block device" ;;
esac
case "$wait_ms" in
  ''|*[!0-9]*) fatal "intar.root_wait_ms $wait_ms is not a positive integer" ;;
esac
if [ "$wait_ms" -lt 1 ] || [ "$wait_ms" -gt 30000 ]; then
  fatal "intar.root_wait_ms $wait_ms is outside 1 to 30000"
fi

# Poll every 20 ms until the deadline. A whole-second sleep would add up to a
# second of boot time when the device appears a few milliseconds late, and the
# device is a built-in virtio-blk disk, so it is present almost immediately.
# CONFIG_FEATURE_FANCY_SLEEP=y in the pinned busybox makes sleep accept the
# fraction. The iteration count is the only bound, so the wait can never run
# past intar.root_wait_ms, and the maximum is 30000 ms.
iterations=$(( (wait_ms + 19) / 20 ))
log "root=$root wait_ms=$wait_ms"
while [ ! -b "$root" ]; do
  if [ "$iterations" -le 0 ]; then
    log "cmdline: $cmdline"
    log "$root did not appear"
    dump_devices
    fatal "root device $root did not appear within $wait_ms ms"
  fi
  iterations=$((iterations - 1))
  $BB sleep 0.02
done
log "$root is present after the wait of at most $wait_ms ms"

# The ext4 primary superblock sits at byte 1024. s_magic is at offset 0x38 and
# s_state is the __le16 at offset 0x3a, so byte 1082 is the low byte of the
# state: 01 is clean, 02 is errors, 03 is both, 00 is in use. This is x86_64,
# which is little-endian, so the low byte is the whole "clean" bit pattern.
#
# od renders one byte as hex text, which keeps the decision a string
# comparison. A busybox ash has no arithmetic base conversion for hex at all,
# so no conversion is attempted here.
needs_check=1
state_hex="$($BB dd if="$root" bs=1 skip=1082 count=1 2>/dev/null | $BB od -An -tx1 | $BB tr -d ' \n')"
case "$state_hex" in
  01) needs_check=0 ;;
  '') log 'cannot read the ext4 superblock state; a check is required' ;;
  *) log "ext4 superblock state byte is $state_hex; a check is required" ;;
esac

if [ "$needs_check" -eq 1 ]; then
  [ -x /sbin/e2fsck.static ] || fatal "$root needs a check and e2fsck.static is not in this initramfs"
  log "checking $root with e2fsck -p"
  $BB sync
  /sbin/e2fsck.static -p "$root"
  status=$?
  case "$status" in
    0) log "$root is clean" ;;
    1) log "e2fsck corrected errors on $root" ;;
    2) fatal "e2fsck corrected errors on $root and requires a reboot; rebuild the image" ;;
    *) fatal "e2fsck left uncorrected errors on $root (exit $status)" ;;
  esac
else
  log "$root was unmounted cleanly; no check is needed"
fi

$BB mount -o rw -t ext4 "$root" /sysroot || {
  log "cmdline: $cmdline"
  fatal "cannot mount $root on /sysroot as ext4"
}

# busybox switch_root needs the new root to be a mount point. Move the mounts
# this initramfs owns first, so the handover does not depend on udev.
$BB mount --move /dev /sysroot/dev || fatal 'cannot move /dev into the new root'
$BB mount --move /proc /sysroot/proc || fatal 'cannot move /proc into the new root'
$BB mount --move /sys /sysroot/sys || fatal 'cannot move /sys into the new root'
log 'handing over to /sbin/init'
exec $BB switch_root /sysroot /sbin/init
