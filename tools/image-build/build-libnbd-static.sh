#!/usr/bin/env bash
# Build the pinned static libnbd archive used by the image builder.
set -euo pipefail

readonly LIBNBD_VERSION='1.22.2'
readonly LIBNBD_TAR='libnbd-1.22.2.tar.gz'
readonly LIBNBD_URL="https://download.libguestfs.org/libnbd/1.22-stable/${LIBNBD_TAR}"
readonly LIBNBD_TAR_SHA256='bdc403af00fd1c9b5ed20503765496a81c2d0197af550765af3dee196e8519ca'
readonly LIBNBD_SIGNATURE_SHA256='0dd24ca3252c16365c52b1232946f078e5278698694133bc918c809cd69b4cc0'
readonly LIBNBD_KEYRING_URL='https://download.libguestfs.org/libguestfs.keyring'
readonly LIBNBD_KEYRING_SHA256='827d8fa129e8ae59d750001c3ebe551aea74343b3786147ae551032405e86ee3'
readonly LIBNBD_SIGNING_FINGERPRINT='F7774FB1AD074A7E8C8767EA91738F73E1B768A0'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PKGCONFIG_PATCH="${SCRIPT_DIR}/libnbd-1.22.2-static-pkgconfig.patch"

if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    printf 'error: libnbd 1.22.2 requires Bash 4 or later\n' >&2
    exit 1
fi

usage() {
    cat <<'USAGE'
Usage: build-libnbd-static.sh --target TARGET --prefix PATH --env-file PATH [--work-root PATH]

Builds the pinned libnbd source as a static library and writes target-specific
pkg-config environment exports for Cargo. Supported targets are:
  x86_64-unknown-linux-musl
  aarch64-unknown-linux-musl
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
USAGE
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

sha256_file() {
    if command -v sha256sum >/dev/null; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

require_sha256() {
    local expected="$1"
    local path="$2"
    local actual
    actual="$(sha256_file "$path")"
    [ "$actual" = "$expected" ] || die "SHA-256 mismatch for '$path'"
}

command_path() {
    command -v "$1" 2>/dev/null || die "missing required build tool '$1'"
}

absolute_path() {
    python3 - "$1" <<'PY'
from pathlib import Path
import sys

print(Path(sys.argv[1]).resolve(strict=False))
PY
}

safe_extract() {
    local archive="$1"
    local destination="$2"
    local entry
    while IFS= read -r entry; do
        case "$entry" in
            ''|/*|../*|*/../*|*/..) die "unsafe libnbd archive path '$entry'" ;;
        esac
    done < <(tar -tzf "$archive")
    tar -xzf "$archive" -C "$destination"
}

write_wrapper() {
    local path="$1"
    local mode="$2"
    local zig="$3"
    local zig_target="$4"
    case "$mode" in
        cc|c++)
            cat > "$path" <<WRAPPER
#!/bin/sh
exec "$zig" $mode -target "$zig_target" "\$@"
WRAPPER
            ;;
        ar)
            cat > "$path" <<WRAPPER
#!/bin/sh
exec "$zig" ar "\$@"
WRAPPER
            ;;
        ranlib)
            cat > "$path" <<WRAPPER
#!/bin/sh
exec "$zig" ar s "\$@"
WRAPPER
            ;;
        *) die "unknown Zig wrapper mode '$mode'" ;;
    esac
    chmod 0755 "$path"
}

write_env_file() {
    local target="$1"
    local prefix="$2"
    local pkgconf="$3"
    local env_file="$4"
    local target_env="${target//-/_}"
    local temporary="${env_file}.tmp"
    mkdir -p "$(dirname -- "$env_file")"
    {
        printf 'export LIBNBD_PREFIX=%q\n' "$prefix"
        printf 'export PKG_CONFIG_%s=%q\n' "$target_env" "$pkgconf"
        printf 'export PKG_CONFIG_PATH_%s=%q\n' "$target_env" "$prefix/lib/pkgconfig"
        printf 'export PKG_CONFIG_LIBDIR_%s=%q\n' "$target_env" "$prefix/lib/pkgconfig"
        printf 'export PKG_CONFIG_ALLOW_CROSS=1\n'
        printf 'export PKG_CONFIG_ALL_STATIC=1\n'
        printf 'export LIBNBD_STATIC=1\n'
    } > "$temporary"
    mv "$temporary" "$env_file"
}

rewrite_prefix() {
    local path="$1"
    local from="$2"
    local to="$3"
    python3 - "$path" "$from" "$to" <<'PY'
from pathlib import Path
import sys

path, old, new = map(Path, sys.argv[1:])
text = path.read_text()
updated = text.replace(str(old), str(new))
if updated == text:
    raise SystemExit(f"expected prefix was absent from {path}")
path.write_text(updated)
PY
}

target=''
prefix=''
env_file=''
work_root=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target)
            target="${2:-}"
            shift 2
            ;;
        --prefix)
            prefix="${2:-}"
            shift 2
            ;;
        --env-file)
            env_file="${2:-}"
            shift 2
            ;;
        --work-root)
            work_root="${2:-}"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "unknown argument '$1'"
            ;;
    esac
done

[ -n "$target" ] || die '--target is required'
[ -n "$prefix" ] || die '--prefix is required'
[ -n "$env_file" ] || die '--env-file is required'
command_path python3 >/dev/null
prefix="$(absolute_path "$prefix")"
env_file="$(absolute_path "$env_file")"
if [ -n "$work_root" ]; then
    work_root="$(absolute_path "$work_root")"
fi
case "$target" in
    x86_64-unknown-linux-musl)
        zig_target='x86_64-linux-musl'
        linker_flags='-static'
        ;;
    aarch64-unknown-linux-musl)
        zig_target='aarch64-linux-musl'
        linker_flags='-static'
        ;;
    x86_64-unknown-linux-gnu)
        zig_target='x86_64-linux-gnu'
        linker_flags=''
        ;;
    aarch64-unknown-linux-gnu)
        zig_target='aarch64-linux-gnu'
        linker_flags=''
        ;;
    *) die "unsupported target '$target'" ;;
esac
case "$prefix" in
    ''|/) die "unsafe prefix '$prefix'" ;;
esac
[ -f "$PKGCONFIG_PATCH" ] || die "missing libnbd pkg-config patch '$PKGCONFIG_PATCH'"

zig="$(command_path zig)"
patch_binary="$(command_path patch)"
gpg="$(command_path gpg)"
make_binary="$(command_path make)"
pkgconf="$(command -v pkgconf 2>/dev/null || command -v pkg-config 2>/dev/null || true)"
[ -n "$pkgconf" ] || die 'missing required build tool pkgconf or pkg-config'
command_path curl >/dev/null
command_path tar >/dev/null
command_path awk >/dev/null

if [ -z "$work_root" ]; then
    work_root="$(mktemp -d "${TMPDIR:-/tmp}/intar-libnbd.XXXXXX")"
    cleanup_work_root=1
else
    mkdir -p "$work_root"
    cleanup_work_root=0
fi
staging_prefix=''
cleanup() {
    if [ -n "$staging_prefix" ] && [ -d "$staging_prefix" ]; then
        rm -rf -- "$staging_prefix"
    fi
    if [ "$cleanup_work_root" -eq 1 ]; then
        rm -rf -- "$work_root"
    fi
}
trap cleanup EXIT

record_dir="${prefix}/share/intar-libnbd"
ready_record="${record_dir}/PROVENANCE"
if [ -f "$ready_record" ] \
    && [ -f "${prefix}/lib/libnbd.a" ] \
    && grep -Fqx "target=${target}" "$ready_record" \
    && grep -Fqx "tar_sha256=${LIBNBD_TAR_SHA256}" "$ready_record" \
    && grep -Fqx "pkgconfig_patch_sha256=$(sha256_file "$PKGCONFIG_PATCH")" "$ready_record"; then
    write_env_file "$target" "$prefix" "$pkgconf" "$env_file"
    exit 0
fi

if [ -e "$prefix" ] && [ ! -f "$ready_record" ]; then
    die "refusing to replace unmanaged prefix '$prefix'"
fi
prefix_parent="$(dirname -- "$prefix")"
prefix_name="$(basename -- "$prefix")"
mkdir -p "$prefix_parent"
staging_prefix="$(mktemp -d "${prefix_parent}/.${prefix_name}.staging.XXXXXX")"
install_prefix="$staging_prefix"
record_dir="${install_prefix}/share/intar-libnbd"
ready_record="${record_dir}/PROVENANCE"
mkdir -p "$work_root/downloads" "$work_root/extract" "$work_root/build" "$work_root/bin" "$work_root/empty-pc"
archive="${work_root}/downloads/${LIBNBD_TAR}"
signature="${archive}.sig"
keyring="${work_root}/downloads/libguestfs.keyring"
gnupg_home="${work_root}/gnupg"
gpg_status="${work_root}/libnbd.gpg.status"
gpg_log="${work_root}/libnbd.gpg.log"

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error \
    --output "$archive" "$LIBNBD_URL"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error \
    --output "$signature" "${LIBNBD_URL}.sig"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error \
    --output "$keyring" "$LIBNBD_KEYRING_URL"
require_sha256 "$LIBNBD_TAR_SHA256" "$archive"
require_sha256 "$LIBNBD_SIGNATURE_SHA256" "$signature"
require_sha256 "$LIBNBD_KEYRING_SHA256" "$keyring"
mkdir -p "$gnupg_home"
chmod 0700 "$gnupg_home"
if ! "$gpg" --homedir "$gnupg_home" --no-default-keyring --keyring "$keyring" \
    --status-fd 1 --verify "$signature" "$archive" > "$gpg_status" 2> "$gpg_log"; then
    die 'libnbd detached signature did not verify'
fi
awk -v fingerprint="$LIBNBD_SIGNING_FINGERPRINT" \
    '$1 == "[GNUPG:]" && $2 == "VALIDSIG" && $3 == fingerprint { valid = 1 } END { exit !valid }' \
    "$gpg_status" \
    || die 'libnbd detached signature did not match the pinned fingerprint'

safe_extract "$archive" "$work_root/extract"
source_root="${work_root}/extract/libnbd-${LIBNBD_VERSION}"
[ -d "$source_root" ] || die 'libnbd archive did not contain its expected root directory'
"$patch_binary" -d "$source_root" -p1 < "$PKGCONFIG_PATCH"

cc_wrapper="${work_root}/bin/cc"
cxx_wrapper="${work_root}/bin/cxx"
ar_wrapper="${work_root}/bin/ar"
ranlib_wrapper="${work_root}/bin/ranlib"
write_wrapper "$cc_wrapper" cc "$zig" "$zig_target"
write_wrapper "$cxx_wrapper" c++ "$zig" "$zig_target"
write_wrapper "$ar_wrapper" ar "$zig" "$zig_target"
write_wrapper "$ranlib_wrapper" ranlib "$zig" "$zig_target"
nm_binary="$(command -v llvm-nm 2>/dev/null || command -v nm 2>/dev/null || true)"
strip_binary="$(command -v llvm-strip 2>/dev/null || command -v strip 2>/dev/null || true)"
[ -n "$nm_binary" ] || die 'missing required build tool nm or llvm-nm'
[ -n "$strip_binary" ] || die 'missing required build tool strip or llvm-strip'

cd "$work_root/build"
configure_log="${work_root}/configure.log"
if ! env \
    CC="$cc_wrapper" \
    CXX="$cxx_wrapper" \
    AR="$ar_wrapper" \
    RANLIB="$ranlib_wrapper" \
    NM="$nm_binary" \
    STRIP="$strip_binary" \
    PKG_CONFIG="$pkgconf" \
    PKG_CONFIG_LIBDIR="${work_root}/empty-pc" \
    PKG_CONFIG_PATH='' \
    OCAMLC=no \
    OCAMLFIND=no \
    CFLAGS='-O2 -fPIC' \
    LDFLAGS="$linker_flags" \
    "$source_root/configure" \
        --host="$target" \
        --prefix="$install_prefix" \
        --disable-shared \
        --enable-static \
        --disable-dependency-tracking \
        --without-gnutls \
        --without-libxml2 \
        --disable-fuse \
        --disable-ublk \
        --disable-ocaml \
        --disable-python \
        --disable-golang \
        --disable-rust \
        --without-bash-completions >"$configure_log" 2>&1; then
    tail -n 100 "$configure_log" >&2
    die "libnbd configure failed; full log: $configure_log"
fi
for make_target in 'common/utils libutils.la' 'lib libnbd.la' 'lib install' 'include install'; do
    read -r make_directory make_goal <<<"$make_target"
    make_log="${work_root}/make-${make_directory//\//_}-${make_goal//\//_}.log"
    if ! "$make_binary" -C "$make_directory" "$make_goal" >"$make_log" 2>&1; then
        tail -n 100 "$make_log" >&2
        die "libnbd make failed; full log: $make_log"
    fi
done

test -f "${install_prefix}/lib/libnbd.a" || die 'libnbd static archive was not installed'
mkdir -p "$record_dir"
cp "$archive" "$signature" "$keyring" "$gpg_status" "$gpg_log" "$PKGCONFIG_PATCH" "$source_root/COPYING.LIB" "$record_dir/"
rewrite_prefix "${install_prefix}/lib/pkgconfig/libnbd.pc" "$install_prefix" "$prefix"
rewrite_prefix "${install_prefix}/lib/libnbd.la" "$install_prefix" "$prefix"
metadata_output="$(env PKG_CONFIG_LIBDIR="${install_prefix}/lib/pkgconfig" PKG_CONFIG_PATH="${install_prefix}/lib/pkgconfig" "$pkgconf" --static --libs --cflags "libnbd >= ${LIBNBD_VERSION}")"
case "$metadata_output" in
    *"-L${prefix}/lib"*"-lnbd"*) ;;
    *) die 'libnbd pkg-config metadata did not expose the static prefix' ;;
esac
{
    printf 'version=%s\n' "$LIBNBD_VERSION"
    printf 'target=%s\n' "$target"
    printf 'source_url=%s\n' "$LIBNBD_URL"
    printf 'tar_sha256=%s\n' "$LIBNBD_TAR_SHA256"
    printf 'signature_sha256=%s\n' "$LIBNBD_SIGNATURE_SHA256"
    printf 'keyring_sha256=%s\n' "$LIBNBD_KEYRING_SHA256"
    printf 'signing_fingerprint=%s\n' "$LIBNBD_SIGNING_FINGERPRINT"
    printf 'pkgconfig_patch_sha256=%s\n' "$(sha256_file "$PKGCONFIG_PATCH")"
    printf 'static_archive_sha256=%s\n' "$(sha256_file "${install_prefix}/lib/libnbd.a")"
    printf 'pkgconfig_static=%s\n' "$metadata_output"
} > "$ready_record"
if [ -e "$prefix" ]; then
    rm -rf -- "$prefix"
fi
mv "$install_prefix" "$prefix"
staging_prefix=''
write_env_file "$target" "$prefix" "$pkgconf" "$env_file"
printf 'prepared static libnbd %s for %s at %s\n' "$LIBNBD_VERSION" "$target" "$prefix"
