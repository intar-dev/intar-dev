#!/bin/sh
# Intar kernel build stage. This script runs inside the normal OCI base-image
# build, as root, in a throw-away stage that the final image does not contain.
#
# intar-image-build fills the placeholder fields from src/kernel.rs. The script
# refuses to run when a token is left behind.
#
# It pins the source and the toolchain, compiles the profile, verifies the
# required built-in feature set, and writes vmlinuz, initrd.img, the module
# metadata tree, and the provenance record into the output directory.
set -eu

out="${1:?usage: intar-kernel-build.sh <output-directory>}"
source_version='@SOURCE_VERSION@'
upstream_major='@UPSTREAM_MAJOR@'
upstream_minor='@UPSTREAM_MINOR@'
upstream_patch='@UPSTREAM_PATCH@'
release='@RELEASE@'
jobs='@JOBS@'
source_date_epoch='@SOURCE_DATE_EPOCH@'
base_url='@BASE_URL@'
snapshot='@SNAPSHOT@'
snapshot_url='@SNAPSHOT_URL@'
busybox_version='@BUSYBOX_VERSION@'
e2fsck_version='@E2FSCK_VERSION@'
build_user='@BUILD_USER@'
build_host='@BUILD_HOST@'
config_fragment="${INTAR_KERNEL_CONFIG:?INTAR_KERNEL_CONFIG is required}"
init_script="${INTAR_KERNEL_INIT_SOURCE:?INTAR_KERNEL_INIT_SOURCE is required}"
apt_ca="${INTAR_APT_CA_INFO:?INTAR_APT_CA_INFO is required}"
work=/build

# Reproducible build inputs. Every one of these is a fixed value.
export DEBIAN_FRONTEND=noninteractive
export KBUILD_BUILD_TIMESTAMP="@$source_date_epoch"
export KBUILD_BUILD_USER="$build_user"
export KBUILD_BUILD_HOST="$build_host"
export SOURCE_DATE_EPOCH="$source_date_epoch"
export LC_ALL=C
export TZ=UTC
umask 0022

log() {
  echo "intar-kernel-build: $*"
}

fail() {
  echo "intar-kernel-build: $*" >&2
  exit 1
}

# The unpacked tree must be the pinned upstream version, not a leftover from an
# earlier unpack and not a different source. The top-level Makefile declares it.
require_makefile_version() {
  grep -q "^$1 = $2\$" "$src/Makefile" ||
    fail "$src/Makefile does not declare $1 = $2; the tree is not the pinned kernel"
}

case "$jobs" in
  ''|*[!0-9]*) fail "job count '$jobs' is not a number" ;;
esac
if [ "$jobs" -lt 1 ] || [ "$jobs" -gt 64 ]; then
  fail "job count '$jobs' is outside 1..=64"
fi
if grep -q '@[A-Z_]*@' "$0" 2>/dev/null; then
  fail 'this script still holds an unfilled token'
fi
test -r "$config_fragment" || fail "missing $config_fragment"
test -r "$init_script" || fail "missing $init_script"

mkdir -p "$out" "$work"

# The toolchain must not float. The kernel stage installs every package from
# one dated Debian snapshot, and the two binaries that reach the initramfs are
# pinned to an exact version on top of that. The base image keeps its own
# pinned digest; only this stage changes its apt source.
log "pinning apt to the $snapshot snapshot"
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
cat > /etc/apt/sources.list <<EOF_APT
deb [check-valid-until=no] $snapshot_url/$snapshot/ trixie main
EOF_APT
apt-get -o "$apt_ca" update >/dev/null

log "installing the pinned kernel build dependencies"
apt-get -o "$apt_ca" install -y --no-install-recommends \
  bc \
  binutils \
  bison \
  busybox-static="$busybox_version" \
  ca-certificates \
  cpio \
  curl \
  dpkg-dev \
  e2fsck-static="$e2fsck_version" \
  flex \
  gcc \
  kmod \
  libc6-dev \
  libelf-dev \
  libssl-dev \
  make \
  xz-utils >/dev/null
test -x /bin/busybox || fail 'busybox-static did not install /bin/busybox'
test -x /sbin/e2fsck.static || fail 'e2fsck-static did not install /sbin/e2fsck.static'

cd "$work"
log "downloading the pinned Debian kernel source $source_version"
cat > intar-kernel-sources.sha256 <<'EOF_SOURCES'
@SOURCE_FILES@
EOF_SOURCES
while read -r digest name; do
  [ -n "$name" ] || continue
  if [ ! -f "$name" ]; then
    curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
      --output "$name" "$base_url/$name"
  fi
  echo "$digest  $name" | sha256sum --check --strict --quiet - || \
    fail "$name does not match the pinned sha256"
done < intar-kernel-sources.sha256

log "unpacking the Debian patch series"
src="$work/unpacked"
# dpkg-source refuses to extract into a directory that already exists, and it
# creates the target itself. The source tree root then lands AT the target: the
# tree has no nested package directory, so nothing is searched for underneath
# it. A stale target from an earlier run must be removed first.
case "$src" in
  "$work"/*) ;;
  *) fail "refusing to clean '$src': it is outside the build directory '$work'" ;;
esac
rm -rf "$src"
dpkg-source --no-check --extract "linux_$source_version.dsc" "$src" >/dev/null
[ -d "$src" ] || fail 'dpkg-source did not create the source directory'
[ -f "$src/Makefile" ] ||
  fail "$src has no Makefile; the unpacked tree is not a kernel source tree"
require_makefile_version VERSION "$upstream_major"
require_makefile_version PATCHLEVEL "$upstream_minor"
require_makefile_version SUBLEVEL "$upstream_patch"
cd "$src"

log "merging the Intar kernel profile over x86_64_defconfig"
make x86_64_defconfig >/dev/null
bash ./scripts/kconfig/merge_config.sh -m .config "$config_fragment" >/dev/null
make olddefconfig >/dev/null

log "verifying the required built-in feature set"
missing=''
while IFS= read -r symbol; do
  [ -n "$symbol" ] || continue
  if ! grep -qx "$symbol=y" .config; then
    missing="$missing $symbol"
  fi
done <<'EOF_REQUIRED'
@REQUIRED_BUILTINS@
EOF_REQUIRED
if [ -n "$missing" ]; then
  fail "the kernel profile is not built in:$missing"
fi

# This build produces bzImage only. A symbol that Kconfig resolves to "=m" is
# not in the kernel, so it is missing from the guest no matter what the fragment
# asked for. Fail on any of them instead of shipping a silent gap: a fragment
# line of "=y" that Kconfig capped at "=m" is a defect in the profile, and the
# list below names every one of them.
m_lines="$(grep -cE '^CONFIG_[A-Z0-9_]*=m$' .config || true)"
if [ "$m_lines" -ne 0 ]; then
  echo "intar-kernel-build: $m_lines symbol(s) resolved to =m, and this build produces bzImage only:" >&2
  grep -E '^CONFIG_[A-Z0-9_]*=m$' .config >&2
  fail 'the profile must be fully built in; set these to =y or turn them off'
fi
log "the final .config is fully built in: no symbol resolved to =m"

log "compiling $release with $jobs parallel jobs"
make -j"$jobs" bzImage

log "collecting the module tree"
modules_dir="$out/modules/lib/modules/$release"
rm -rf "$out/modules"
mkdir -p "$modules_dir"
# The =m gate above already proved the kernel has nothing to load, so there is
# no install step for loadable modules and no compatibility path: this tree is
# metadata only, and depmod indexes it below.
printf 'Intar: every profile feature is built in; there are no loadable modules.\n' \
  > "$modules_dir/README.intar"
# The guest boot loads the names in /etc/modules-load.d with modprobe. For a
# built-in name, modprobe answers from the modules.builtin index, so that index
# must exist even when the profile produces no loadable module. depmod then
# writes the dependency and alias indexes over whatever this tree holds.
for metadata in modules.builtin modules.builtin.modinfo modules.order; do
  if [ -f "$metadata" ]; then
    install -m 0644 "$metadata" "$modules_dir/$metadata"
  fi
done
# depmod reads modules.order and warns when it is absent. The kernel writes that
# file only when it builds a module, and a fully built-in profile builds none,
# so an empty file is created to keep the index build warning-free. It is not a
# placeholder for a missing feature: the =m gate above already rejected any
# symbol that would have needed one.
if [ ! -f "$modules_dir/modules.order" ]; then
  : > "$modules_dir/modules.order"
fi
test -f "$modules_dir/modules.builtin" ||
  fail 'the kernel build did not produce modules.builtin; modprobe for a built-in name needs it'
depmod -b "$out/modules" -w "$release" >/dev/null
test -f "$modules_dir/modules.dep" || fail 'depmod did not write modules.dep'
test -d "$modules_dir"

log "building the minimal initramfs"
initramfs="$work/initramfs"
rm -rf "$initramfs"
mkdir -p "$initramfs/bin" "$initramfs/dev" "$initramfs/proc" "$initramfs/sbin" \
  "$initramfs/sys" "$initramfs/sysroot"
install -m 0755 /bin/busybox "$initramfs/bin/busybox"
install -m 0755 /sbin/e2fsck.static "$initramfs/sbin/e2fsck.static"
install -m 0755 "$init_script" "$initramfs/init"
# Every entry carries the pinned timestamp, so the archive is byte-identical
# for identical inputs.
find "$initramfs" -depth -exec touch -h -d "@$source_date_epoch" {} +
install -m 0644 arch/x86/boot/bzImage "$out/vmlinuz"
touch -h -d "@$source_date_epoch" "$out/vmlinuz"

cd "$initramfs"
find . -mindepth 1 -print0 | LC_ALL=C sort -z | \
  cpio --quiet --reproducible --null -o -H newc --owner=0:0 > "$work/initrd.img.cpio"
cd "$work"
gzip -9n -c "$work/initrd.img.cpio" > "$out/initrd.img"
rm -f "$work/initrd.img.cpio"

vmlinuz_sha256="$(sha256sum "$out/vmlinuz" | cut -d' ' -f1)"
initrd_sha256="$(sha256sum "$out/initrd.img" | cut -d' ' -f1)"
config_sha256="$(sha256sum "$src/.config" | cut -d' ' -f1)"
config_fragment_sha256="$(sha256sum "$config_fragment" | cut -d' ' -f1)"
init_sha256="$(sha256sum "$init_script" | cut -d' ' -f1)"
cc_version="$(gcc -dumpfullversion)"
gcc_deb="$(dpkg-query -W -f='${Version}' gcc 2>/dev/null || echo unknown)"
busybox_deb="$(dpkg-query -W -f='${Version}' busybox-static 2>/dev/null || echo unknown)"
e2fsck_deb="$(dpkg-query -W -f='${Version}' e2fsck-static 2>/dev/null || echo unknown)"
cat > "$out/kernel-build.json" <<EOF_PROVENANCE
{"schema_version":1,"source_package":"linux","source_version":"$source_version","release":"$release","source_date_epoch":$source_date_epoch,"apt_snapshot":"$snapshot","config_fragment_sha256":"$config_fragment_sha256","config_sha256":"$config_sha256","vmlinuz_sha256":"$vmlinuz_sha256","initrd_sha256":"$initrd_sha256","initramfs_init_sha256":"$init_sha256","gcc_version":"$cc_version","gcc_deb_version":"$gcc_deb","busybox_deb_version":"$busybox_deb","e2fsck_deb_version":"$e2fsck_deb","jobs":$jobs}
EOF_PROVENANCE

log "built $release: vmlinuz $vmlinuz_sha256, initrd $initrd_sha256"
