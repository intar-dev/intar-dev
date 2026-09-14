#!/usr/bin/env bash
# Prepare the pinned libnbd Rust bindings that the Rust workspace resolves.
#
# Upstream publishes these bindings only inside the libnbd source tree, and it
# generates libnbd-sys/libnbd_version during its own build. Cargo cannot resolve
# the workspace while the path dependency is absent, so every entrypoint that
# runs Cargo prepares this ignored cache first. See with-libnbd-env.sh.
#
# The cache path is fixed by crates/intar-image-build/Cargo.toml. Preparation is
# serialized with a lock directory and installed with an atomic rename, so
# concurrent callers adopt a finished cache instead of deleting it. The lock
# records its owner, so a lock is only reclaimed from an owner that is provably
# gone.
#
# The pinned tarball SHA-256 below is the integrity anchor for the source used
# here. The release build additionally verifies the upstream detached signature
# while it builds the static archive; see build-libnbd-static.sh.
set -euo pipefail

readonly LIBNBD_VERSION='1.22.2'
readonly LIBNBD_TAR='libnbd-1.22.2.tar.gz'
readonly LIBNBD_URL="https://download.libguestfs.org/libnbd/1.22-stable/${LIBNBD_TAR}"
# Keep these download pins identical to build-libnbd-static.sh. That script
# stays self-contained because release archives ship a copy of it.
readonly LIBNBD_TAR_SHA256='bdc403af00fd1c9b5ed20503765496a81c2d0197af550765af3dee196e8519ca'
readonly LIBNBD_SOURCE_COMMIT='5f55a26f3a776c11049a27154b1f2b59b8c335da'
readonly LOCK_WAIT_SECONDS=600
# Age is only a fallback for a lock whose owner cannot be judged.
readonly STALE_LOCK_MINUTES=10
readonly OWN_HOST="$(uname -n)"
readonly MY_TOKEN="$$-$(date +%s)-${RANDOM}"

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CACHE_ROOT="${SCRIPT_DIR}/../../target/libnbd-rust"
readonly BINDINGS_ROOT="${CACHE_ROOT}/${LIBNBD_VERSION}"
readonly BINDINGS_DIR="${BINDINGS_ROOT}/rust"
readonly READY_RECORD="${BINDINGS_ROOT}/PROVENANCE"
readonly LOCK_DIR="${CACHE_ROOT}/.${LIBNBD_VERSION}.prepare.lock"

usage() {
    cat <<'USAGE'
Usage: prepare-libnbd-rust.sh

Extracts the pinned libnbd Rust bindings into the ignored cache at
target/libnbd-rust/<version>/rust and records their provenance. The script is
idempotent: a matching ready record skips the download and the extraction, and
concurrent callers serialize on a lock directory.
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

safe_extract() {
    local archive="$1"
    local destination="$2"
    shift 2
    local entry
    while IFS= read -r entry; do
        case "$entry" in
            ''|/*|../*|*/../*|*/..) die "unsafe libnbd archive path '$entry'" ;;
        esac
    done < <(tar -tzf "$archive" "$@")
    tar -xzf "$archive" -C "$destination" "$@"
}

# A cache is ready only when everything Cargo reads is present, so readiness
# becomes true atomically with the rename that installs the directory.
cache_is_ready() {
    [ -f "$READY_RECORD" ] \
        && [ -f "${BINDINGS_DIR}/Cargo.toml" ] \
        && [ -f "${BINDINGS_DIR}/libnbd-sys/libnbd_version" ] \
        && [ -f "${BINDINGS_DIR}/PROVENANCE.md" ] \
        && grep -Fqx "version=${LIBNBD_VERSION}" "$READY_RECORD" \
        && grep -Fqx "tar_sha256=${LIBNBD_TAR_SHA256}" "$READY_RECORD" \
        && grep -Fqx "source_commit=${LIBNBD_SOURCE_COMMIT}" "$READY_RECORD"
}

# Prints one field of the lock owner record, empty when it is absent.
lock_field() {
    local file="${LOCK_DIR}/owner"
    [ -f "$file" ] || return 0
    sed -n "s/^$1=//p" "$file" | head -n 1
}

# Age alone never reclaims a lock. A slow download can hold one for a long time,
# and reaping a live owner would let its exit trap delete the next owner's lock.
# The lock is reclaimed only when its recorded owner is provably gone. An owner
# that cannot be judged, because the record is unreadable or names another host,
# must age out first.
lock_is_reclaimable() {
    local pid
    pid="$(lock_field pid)"
    case "$pid" in
        ''|*[!0-9]*) ;;
        *)
            if [ "$(lock_field host)" = "$OWN_HOST" ]; then
                ! kill -0 "$pid" 2>/dev/null
                return
            fi
            ;;
    esac
    [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin "+${STALE_LOCK_MINUTES}" 2>/dev/null)" ]
}

# mkdir is the portable atomic test-and-set here: it needs no flock and works on
# Linux, macOS, and Git Bash. Returns 1 when another caller finished the cache
# while this caller waited, which means there is nothing left to do.
acquire_lock() {
    local deadline=$((SECONDS + LOCK_WAIT_SECONDS))
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
        if cache_is_ready; then
            return 1
        fi
        if lock_is_reclaimable; then
            printf 'warning: reclaiming abandoned libnbd preparation lock %s\n' "$LOCK_DIR" >&2
            rm -rf -- "$LOCK_DIR"
            continue
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            die "timed out after ${LOCK_WAIT_SECONDS}s waiting for the libnbd preparation lock ${LOCK_DIR}"
        fi
        sleep 1
    done
    if ! printf 'pid=%s\nhost=%s\ntoken=%s\n' "$$" "$OWN_HOST" "$MY_TOKEN" > "${LOCK_DIR}/owner"; then
        rm -rf -- "$LOCK_DIR"
        die "cannot record the libnbd preparation lock owner at ${LOCK_DIR}/owner"
    fi
    return 0
}

case "${1:-}" in
    --help|-h)
        usage
        exit 0
        ;;
    '')
        ;;
    *)
        usage >&2
        die "unknown argument '$1'"
        ;;
esac

if cache_is_ready; then
    exit 0
fi

command -v curl >/dev/null || die "missing required build tool 'curl'"
command -v tar >/dev/null || die "missing required build tool 'tar'"
command -v awk >/dev/null || die "missing required build tool 'awk'"

mkdir -p "$CACHE_ROOT"
if [ -e "$BINDINGS_ROOT" ] && [ ! -d "$BINDINGS_ROOT" ]; then
    die "refusing to replace non-directory '${BINDINGS_ROOT}'"
fi

if ! acquire_lock; then
    # Another caller completed the cache while this caller waited.
    exit 0
fi

work_root=''
staging_root=''
lock_held=1
cleanup() {
    if [ -n "$staging_root" ] && [ -d "$staging_root" ]; then
        rm -rf -- "$staging_root"
    fi
    if [ -n "$work_root" ] && [ -d "$work_root" ]; then
        rm -rf -- "$work_root"
    fi
    # Remove the lock only while this process still owns it. A lock that was
    # reclaimed and taken by another caller must survive this exit.
    if [ "$lock_held" -eq 1 ] && [ "$(lock_field token)" = "$MY_TOKEN" ]; then
        rm -rf -- "$LOCK_DIR"
    fi
}
trap cleanup EXIT

# Re-check under the lock. A cache that another caller installed between the
# first check and the lock acquisition is adopted, never replaced.
if cache_is_ready; then
    exit 0
fi

work_root="$(mktemp -d "${TMPDIR:-/tmp}/intar-libnbd-rust.XXXXXX")"

archive="${work_root}/${LIBNBD_TAR}"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-connrefused \
    --connect-timeout 15 --max-time 300 --silent --show-error \
    --output "$archive" "$LIBNBD_URL"
require_sha256 "$LIBNBD_TAR_SHA256" "$archive"

mkdir -p "${work_root}/extract"
source_subtree="libnbd-${LIBNBD_VERSION}/rust"
license_path="libnbd-${LIBNBD_VERSION}/COPYING.LIB"
safe_extract "$archive" "${work_root}/extract" "$source_subtree" "$license_path"
source_root="${work_root}/extract/${source_subtree}"
[ -f "${source_root}/Cargo.toml" ] || die 'libnbd archive did not contain the expected Rust bindings'

staging_root="$(mktemp -d "${CACHE_ROOT}/.${LIBNBD_VERSION}.staging.XXXXXX")"
mkdir -p "${staging_root}/rust"
cp -R "${source_root}/." "${staging_root}/rust/"
# Upstream writes this one-line file from its own Makefile; Cargo reads it in
# libnbd-sys/build.rs.
printf '%s\n' "$LIBNBD_VERSION" > "${staging_root}/rust/libnbd-sys/libnbd_version"
cp "${work_root}/extract/${license_path}" "${staging_root}/rust/COPYING.LIB"

cat <<NOTICE > "${staging_root}/rust/PROVENANCE.md"
# libnbd Rust bindings provenance

Prepared cache for crates/intar-image-build. Do not edit and do not commit;
prepare-libnbd-rust.sh recreates this directory from the pinned release.

- Upstream tag: v${LIBNBD_VERSION}
- Upstream commit: ${LIBNBD_SOURCE_COMMIT}
- Source tarball: ${LIBNBD_URL}
- Tar SHA-256: ${LIBNBD_TAR_SHA256}
- License: LGPL-2.1-or-later; see COPYING.LIB in this directory.

This directory is the unmodified rust/ subtree from that release. The only
added file is libnbd-sys/libnbd_version, which upstream generates during its
own build. Release archives carry this directory as rust-bindings/.
NOTICE

{
    printf 'version=%s\n' "$LIBNBD_VERSION"
    printf 'tar_url=%s\n' "$LIBNBD_URL"
    printf 'tar_sha256=%s\n' "$LIBNBD_TAR_SHA256"
    printf 'source_commit=%s\n' "$LIBNBD_SOURCE_COMMIT"
    printf 'bindings_path=%s\n' "target/libnbd-rust/${LIBNBD_VERSION}/rust"
} > "${staging_root}/PROVENANCE"

# mktemp creates the staging directory private to this process. Publish it with
# the readable mode the installed cache needs.
chmod 0755 "$staging_root"

# Install the finished tree with one rename. A tree that exists here can only be
# one that failed the readiness check above, and it is moved aside rather than
# deleted in place, so no reader ever sees a half-removed cache.
if [ -d "$BINDINGS_ROOT" ]; then
    stale_root="$(mktemp -d "${CACHE_ROOT}/.${LIBNBD_VERSION}.stale.XXXXXX")"
    mv "$BINDINGS_ROOT" "${stale_root}/previous"
    rm -rf -- "$stale_root"
fi
mv "$staging_root" "$BINDINGS_ROOT"
staging_root=''
printf 'prepared libnbd %s Rust bindings at %s\n' "$LIBNBD_VERSION" "$BINDINGS_DIR" >&2
