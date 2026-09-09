#!/usr/bin/env bash
# Copy libnbd source, license, and static-link inputs into a release workdir.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly BINDINGS_DIR="${SCRIPT_DIR}/../../third_party/libnbd-rust"
readonly BUILD_SCRIPT="${SCRIPT_DIR}/build-libnbd-static.sh"

usage() {
    cat <<'USAGE'
Usage: package-libnbd-static-artifacts.sh --prefix PATH --destination PATH
USAGE
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

prefix=''
destination=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix)
            prefix="${2:-}"
            shift 2
            ;;
        --destination)
            destination="${2:-}"
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
[ -n "$prefix" ] || die '--prefix is required'
[ -n "$destination" ] || die '--destination is required'

source_dir="${prefix}/share/intar-libnbd"
test -f "${prefix}/lib/libnbd.a" || die "missing static archive under '$prefix'"
test -f "${prefix}/include/libnbd.h" || die "missing libnbd header under '$prefix'"
test -f "${prefix}/lib/pkgconfig/libnbd.pc" || die "missing libnbd pkg-config metadata under '$prefix'"
test -f "${source_dir}/PROVENANCE" || die "missing libnbd provenance under '$prefix'"
test -f "${BINDINGS_DIR}/PROVENANCE.md" || die "missing vendored bindings provenance"
test -f "${BINDINGS_DIR}/COPYING.LIB" || die "missing vendored bindings license"
test -x "$BUILD_SCRIPT" || die "missing libnbd static build script"
if [ -e "$destination" ] || [ -L "$destination" ]; then
    die "refusing to replace existing destination '$destination'"
fi

mkdir -p "$destination/source" "$destination/relink" "$destination/rust-bindings"
cp -R "$source_dir/." "$destination/source/"
cp "$BUILD_SCRIPT" "$destination/source/build-libnbd-static.sh"
cp "${prefix}/lib/libnbd.a" "$destination/relink/libnbd.a"
cp "${prefix}/include/libnbd.h" "$destination/relink/libnbd.h"
cp "${prefix}/lib/pkgconfig/libnbd.pc" "$destination/relink/libnbd.pc"
cp -R "$BINDINGS_DIR/." "$destination/rust-bindings/"
cat <<'NOTICE' > "$destination/THIRD_PARTY_NOTICES.md"
# libnbd static-link materials

This release statically links libnbd 1.22.2 and its official Rust bindings.
Both are LGPL-2.1-or-later. `source/` contains the verified source material,
license, detached signature, key record, package patch, and build provenance.
`relink/` contains the static C archive, public header, and pkg-config metadata
used to link the released binary. `rust-bindings/` is the exact official binding
source snapshot used by Cargo. `source/build-libnbd-static.sh` is the exact
verified static build command and metadata patch used for this release.

The matching release tag contains the application source, `Cargo.lock`, and
the build command. Use that source with this directory to relink the
application against a modified libnbd archive.
NOTICE
(
    cd "$destination"
    find . -type f ! -path './SHA256SUMS' -print0 \
        | LC_ALL=C sort -z \
        | xargs -0 sha256sum > SHA256SUMS
)
