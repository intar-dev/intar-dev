#!/usr/bin/env bash
# Checks for the pinned libnbd Rust bindings.
#
# Every case that prepares, repairs, or damages a cache runs against an isolated
# fixture that mirrors the repository layout, so this suite never writes to the
# shared target/ cache that concurrent Cargo builds read. Cases that only inspect
# repository wiring read the real checkout and change nothing.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly WORKFLOW_DIR="${REPO_ROOT}/.github/workflows"
readonly EXPECTED_VERSION='1.22.2'
# The prepared tree is the upstream rust/ subtree plus COPYING.LIB,
# PROVENANCE.md, and the generated libnbd-sys/libnbd_version.
readonly EXPECTED_FILES=64
readonly LOCK_WAIT_OBSERVED_SECONDS=6

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
    printf 'FAIL %s\n' "$1" >&2
    failures=$((failures + 1))
}
check_equal() {
    if [ "$2" = "$3" ]; then
        pass "$1"
    else
        fail "$1: expected '$3', got '$2'"
    fi
}
check_true() {
    local description="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        pass "$description"
    else
        fail "$description"
    fi
}
check_fails() {
    local description="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        fail "$description: command unexpectedly succeeded"
    else
        pass "$description"
    fi
}

hash_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

tree_fingerprint() {
    ( cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r file; do
        printf '%s %s\n' "$(hash_of "$file")" "$file"
    done ) | hash_of /dev/stdin
}

dir_identity() { ls -di "$1" | awk '{print $1}'; }
count_files() { find "$1" -type f | wc -l | tr -d ' '; }
count_entries() { find "$1" -maxdepth 1 -name "$2" | wc -l | tr -d ' '; }

mode_of() {
    if stat -f '%Lp' "$1" >/dev/null 2>&1; then
        stat -f '%Lp' "$1"
    else
        stat -c '%a' "$1"
    fi
}

verify_checksums() {
    if command -v sha256sum >/dev/null 2>&1; then
        ( cd "$1" && sha256sum --check --strict SHA256SUMS >/dev/null 2>&1 )
    else
        ( cd "$1" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1 )
    fi
}

pin_value() {
    grep -F "readonly $2=" "$1" | head -n 1 | cut -d= -f2- | tr -d "'\""
}

wait_for() {
    if wait "$1"; then
        pass "$2"
    else
        fail "$2"
    fi
}

acquire_lock() {
    mkdir "$1"
    printf 'pid=%s\nhost=%s\ntoken=%s\n' "$2" "$(uname -n)" "$3" > "$1/owner"
}

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/intar-libnbd-check.XXXXXX")"
trap 'rm -rf -- "$tmp_root"' EXIT

# Every Cargo entrypoint prepares this cache, so prepare it here too and treat a
# cache that is already present as the normal adopted state.
readonly REPO_TOOLS="${REPO_ROOT}/tools/image-build"
readonly REPO_CACHE="${REPO_ROOT}/target/libnbd-rust/${EXPECTED_VERSION}"
bash "${REPO_TOOLS}/prepare-libnbd-rust.sh"
check_true "repository cache is prepared" test -f "${REPO_CACHE}/rust/Cargo.toml"
shared_before="$(tree_fingerprint "${REPO_CACHE}/rust")"

# A fixture is a throwaway repository root holding a copy of tools/image-build,
# so preparing and repairing inside it cannot disturb the shared cache.
new_fixture() {
    local root
    root="$(mktemp -d "${tmp_root}/fixture.XXXXXX")"
    mkdir -p "${root}/tools"
    cp -R "${REPO_TOOLS}" "${root}/tools/image-build"
    chmod 0755 "${root}/tools/image-build"/*.sh
    printf '%s\n' "$root"
}

fixture="$(new_fixture)"
fixture_prepare="${fixture}/tools/image-build/prepare-libnbd-rust.sh"
fixture_wrapper="${fixture}/tools/image-build/with-libnbd-env.sh"
fixture_package="${fixture}/tools/image-build/package-libnbd-static-artifacts.sh"
fixture_cache="${fixture}/target/libnbd-rust"
fixture_version="${fixture_cache}/${EXPECTED_VERSION}"
fixture_lock="${fixture_cache}/.${EXPECTED_VERSION}.prepare.lock"

check_true "prepare --help exits 0" bash "$fixture_prepare" --help
check_fails "prepare rejects an unknown argument" bash "$fixture_prepare" --unknown
check_fails "wrapper requires a command" bash "$fixture_wrapper"
check_fails "wrapper requires a value for --target" bash "$fixture_wrapper" --target

bash "$fixture_prepare" >"${tmp_root}/prepare-stdout" 2>"${tmp_root}/prepare-stderr"

check_equal "prepared tree holds ${EXPECTED_FILES} files" "$(count_files "${fixture_version}/rust")" "$EXPECTED_FILES"
check_equal "generated version file" "$(cat "${fixture_version}/rust/libnbd-sys/libnbd_version")" "$EXPECTED_VERSION"
check_equal "prepared cache root mode" "$(mode_of "$fixture_version")" "755"
check_true "ready record exists" test -f "${fixture_version}/PROVENANCE"
check_true "bindings provenance exists" test -f "${fixture_version}/rust/PROVENANCE.md"
check_true "bindings license exists" test -f "${fixture_version}/rust/COPYING.LIB"
check_true "prepared source manifest exists" test -f "${fixture_version}/rust/Cargo.toml"
check_equal "prepare writes nothing to stdout" "$(wc -c <"${tmp_root}/prepare-stdout" | tr -d ' ')" "0"

printf 'payload\n' >"${tmp_root}/expected-stdout"
bash "$fixture_wrapper" --rust-only -- printf 'payload\n' >"${tmp_root}/wrapper-stdout" 2>"${tmp_root}/wrapper-stderr"
check_true "wrapper forwards only the wrapped command on stdout" cmp -s "${tmp_root}/expected-stdout" "${tmp_root}/wrapper-stdout"

installed_identity="$(dir_identity "$fixture_version")"
installed_fingerprint="$(tree_fingerprint "${fixture_version}/rust")"
bash "$fixture_prepare"
check_equal "rerun keeps the installed directory" "$(dir_identity "$fixture_version")" "$installed_identity"
check_equal "rerun does not rewrite the tree" "$(tree_fingerprint "${fixture_version}/rust")" "$installed_fingerprint"

# A ready cache must be adopted by every caller, never replaced.
bash "$fixture_prepare" >/dev/null 2>&1 &
ready_first=$!
bash "$fixture_prepare" >/dev/null 2>&1 &
ready_second=$!
wait_for "$ready_first" "parallel caller over a ready cache: first"
wait_for "$ready_second" "parallel caller over a ready cache: second"
check_equal "ready cache keeps its identity under parallel callers" "$(dir_identity "$fixture_version")" "$installed_identity"
check_equal "ready cache keeps its contents under parallel callers" "$(tree_fingerprint "${fixture_version}/rust")" "$installed_fingerprint"

# An interrupted install must be repaired by concurrent callers without either
# one deleting a cache the other completed.
rm -f "${fixture_version}/PROVENANCE"
bash "$fixture_prepare" >/dev/null 2>&1 &
repair_first=$!
bash "$fixture_prepare" >/dev/null 2>&1 &
repair_second=$!
wait_for "$repair_first" "repairing caller: first"
wait_for "$repair_second" "repairing caller: second"
check_equal "repair restores ${EXPECTED_FILES} files" "$(count_files "${fixture_version}/rust")" "$EXPECTED_FILES"
check_true "repair restores the ready record" test -f "${fixture_version}/PROVENANCE"
check_true "repair leaves no lock directory" test ! -e "$fixture_lock"
check_equal "no leftover staging directories" "$(count_entries "$fixture_cache" '*.staging.*')" "0"
check_equal "no leftover stale directories" "$(count_entries "$fixture_cache" '*.stale.*')" "0"

# A tree that fails readiness must be replaced instead of adopted.
rm -f "${fixture_version}/rust/libnbd-sys/libnbd_version"
bash "$fixture_prepare" >/dev/null 2>&1
check_equal "missing version file is restored" "$(cat "${fixture_version}/rust/libnbd-sys/libnbd_version")" "$EXPECTED_VERSION"

# Two callers that both start from nothing must not corrupt each other.
cold="$(new_fixture)"
cold_cache="${cold}/target/libnbd-rust"
bash "${cold}/tools/image-build/prepare-libnbd-rust.sh" >/dev/null 2>&1 &
cold_first=$!
bash "${cold}/tools/image-build/prepare-libnbd-rust.sh" >/dev/null 2>&1 &
cold_second=$!
wait_for "$cold_first" "cold preparer: first"
wait_for "$cold_second" "cold preparer: second"
check_equal "cold race prepares ${EXPECTED_FILES} files" "$(count_files "${cold_cache}/${EXPECTED_VERSION}/rust")" "$EXPECTED_FILES"
check_equal "cold race keeps one ready record" "$(count_entries "${cold_cache}/${EXPECTED_VERSION}" 'PROVENANCE')" "1"
check_equal "cold race leaves no lock" "$(count_entries "$cold_cache" '*.prepare.lock')" "0"
check_equal "cold race leaves no staging directories" "$(count_entries "$cold_cache" '*.staging.*')" "0"

# A lock is reclaimed only when its recorded owner is provably gone.
reclaim="$(new_fixture)"
reclaim_cache="${reclaim}/target/libnbd-rust"
reclaim_lock="${reclaim_cache}/.${EXPECTED_VERSION}.prepare.lock"
mkdir -p "$reclaim_cache"
( exit 0 ) &
dead_owner=$!
wait "$dead_owner" 2>/dev/null || true
acquire_lock "$reclaim_lock" "$dead_owner" 'dead-owner-token'
bash "${reclaim}/tools/image-build/prepare-libnbd-rust.sh" >/dev/null 2>"${tmp_root}/reclaim-stderr"
check_true "dead owner lock is reclaimed" grep -Fq 'reclaiming abandoned' "${tmp_root}/reclaim-stderr"
check_true "dead owner lock is released" test ! -e "$reclaim_lock"
check_true "reclaimed lock still prepares the cache" test -f "${reclaim_cache}/${EXPECTED_VERSION}/rust/Cargo.toml"

# A live owner keeps its lock however old it is, and a caller that gives up must
# not delete a lock it does not own.
live="$(new_fixture)"
live_cache="${live}/target/libnbd-rust"
live_lock="${live_cache}/.${EXPECTED_VERSION}.prepare.lock"
mkdir -p "$live_cache"
sleep 300 &
live_owner=$!
acquire_lock "$live_lock" "$live_owner" 'live-owner-token'
touch -t 202001010000 "$live_lock"
live_owner_record="$(cat "$live_lock/owner")"
bash "${live}/tools/image-build/prepare-libnbd-rust.sh" >/dev/null 2>&1 &
waiting=$!
sleep "$LOCK_WAIT_OBSERVED_SECONDS"
check_true "live owner keeps the lock past the stale age" test -d "$live_lock"
check_equal "live owner record is untouched" "$(cat "$live_lock/owner")" "$live_owner_record"
kill "$waiting" 2>/dev/null || true
wait "$waiting" 2>/dev/null || true
check_true "a caller that gives up leaves a foreign lock alone" test -d "$live_lock"
check_true "a caller that gives up prepares nothing" test ! -e "${live_cache}/${EXPECTED_VERSION}"
kill "$live_owner" 2>/dev/null || true
wait "$live_owner" 2>/dev/null || true
rm -rf "$live_lock"

# Download failures must fail closed and leave no partial cache behind.
shim_dir="${tmp_root}/shim"
mkdir -p "$shim_dir"
cat >"$shim_dir/curl" <<'SHIM'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'not the pinned libnbd tarball
' > "$out"
SHIM
chmod 0755 "$shim_dir/curl"

bad_hash="$(new_fixture)"
PATH="$shim_dir:${PATH}" bash "${bad_hash}/tools/image-build/prepare-libnbd-rust.sh" \
    >/dev/null 2>"${tmp_root}/bad-hash-stderr" && bad_hash_status=0 || bad_hash_status=$?
check_true "a mismatched tarball fails the run" test "$bad_hash_status" -ne 0
check_true "a mismatched tarball reports the digest failure" grep -Fq 'SHA-256 mismatch' "${tmp_root}/bad-hash-stderr"
check_true "a mismatched tarball leaves no cache" test ! -e "${bad_hash}/target/libnbd-rust/${EXPECTED_VERSION}"
check_equal "a mismatched tarball leaves no lock" "$(count_entries "${bad_hash}/target/libnbd-rust" '*.prepare.lock')" "0"

cat >"$shim_dir/curl" <<'SHIM'
#!/bin/sh
printf 'curl: (6) could not resolve host: download.libguestfs.org
' >&2
exit 6
SHIM
chmod 0755 "$shim_dir/curl"

unreachable="$(new_fixture)"
PATH="$shim_dir:${PATH}" bash "${unreachable}/tools/image-build/prepare-libnbd-rust.sh" \
    >/dev/null 2>"${tmp_root}/unreachable-stderr" && unreachable_status=0 || unreachable_status=$?
check_true "an unreachable host fails the run" test "$unreachable_status" -ne 0
check_true "an unreachable host leaves no cache" test ! -e "${unreachable}/target/libnbd-rust/${EXPECTED_VERSION}"
check_equal "an unreachable host leaves no lock" "$(count_entries "${unreachable}/target/libnbd-rust" '*.prepare.lock')" "0"

prefix="${tmp_root}/prefix"
artifact="${tmp_root}/artifact"
mkdir -p "$prefix/lib/pkgconfig" "$prefix/include" "$prefix/share/intar-libnbd"
: >"$prefix/lib/libnbd.a"
: >"$prefix/include/libnbd.h"
: >"$prefix/lib/pkgconfig/libnbd.pc"
printf 'version=%s\n' "$EXPECTED_VERSION" >"$prefix/share/intar-libnbd/PROVENANCE"
if ! command -v sha256sum >/dev/null 2>&1; then
    # The packaging script assumes GNU sha256sum; macOS ships shasum instead.
    printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' >"$shim_dir/sha256sum"
    chmod 0755 "$shim_dir/sha256sum"
    PATH="$shim_dir:${PATH}"
fi
bash "$fixture_package" --prefix "$prefix" --destination "$artifact"
check_equal "packaged bindings keep the version file" "$(cat "$artifact/rust-bindings/libnbd-sys/libnbd_version")" "$EXPECTED_VERSION"
check_true "packaged bindings carry provenance" test -f "$artifact/rust-bindings/PROVENANCE.md"
check_true "packaged bindings carry the license" test -f "$artifact/rust-bindings/COPYING.LIB"
check_true "packaged source provenance is retained" test -f "$artifact/source/PROVENANCE"
check_true "packaged static build script is retained" test -x "$artifact/source/build-libnbd-static.sh"
check_true "packaged relink archive is retained" test -f "$artifact/relink/libnbd.a"
check_true "packaged checksums verify" verify_checksums "$artifact"

guard_root="${tmp_root}/guard/tools/image-build"
mkdir -p "$guard_root"
cp "${REPO_TOOLS}/package-libnbd-static-artifacts.sh" "${REPO_TOOLS}/build-libnbd-static.sh" "$guard_root/"
chmod 0755 "$guard_root"/*.sh
check_fails "packaging fails without prepared bindings" \
    bash "$guard_root/package-libnbd-static-artifacts.sh" --prefix "$prefix" --destination "${tmp_root}/artifact-guard"

# The C release build and this cache must pin the same authenticated release.
rust_pins="${REPO_TOOLS}/prepare-libnbd-rust.sh"
c_pins="${REPO_TOOLS}/build-libnbd-static.sh"
check_equal "Rust and C scripts pin the same libnbd version" \
    "$(pin_value "$rust_pins" LIBNBD_VERSION)" "$(pin_value "$c_pins" LIBNBD_VERSION)"
check_equal "Rust and C scripts pin the same tarball URL" \
    "$(pin_value "$rust_pins" LIBNBD_URL)" "$(pin_value "$c_pins" LIBNBD_URL)"
check_equal "Rust and C scripts pin the same tarball SHA-256" \
    "$(pin_value "$rust_pins" LIBNBD_TAR_SHA256)" "$(pin_value "$c_pins" LIBNBD_TAR_SHA256)"
check_equal "cache version pin matches the expected version" \
    "$(pin_value "$rust_pins" LIBNBD_VERSION)" "$EXPECTED_VERSION"
check_true "ready record matches the pinned tarball" grep -Fqx \
    "tar_sha256=$(pin_value "$rust_pins" LIBNBD_TAR_SHA256)" "${REPO_CACHE}/PROVENANCE"

manifest_relative="$(sed -n 's/^libnbd = .*path = "\([^"]*\)".*/\1/p' "${REPO_ROOT}/crates/intar-image-build/Cargo.toml" | head -n 1)"
# The manifest path is relative to the crate directory.
check_equal "manifest pins the prepared cache path" "$manifest_relative" "../../target/libnbd-rust/${EXPECTED_VERSION}/rust"
check_equal "manifest version matches the script pin" \
    "${manifest_relative#../../target/libnbd-rust/}" "${EXPECTED_VERSION}/rust"
check_equal "workspace excludes the prepared cache" \
    "$(sed -n 's/^exclude = \["\(.*\)"\]/\1/p' "${REPO_ROOT}/Cargo.toml" | head -n 1)" "target/libnbd-rust/${EXPECTED_VERSION}/rust"
check_true "prepared cache is git-ignored" git -C "${REPO_ROOT}" check-ignore -q "target/libnbd-rust/${EXPECTED_VERSION}/rust/Cargo.toml"
check_true "vendored tree is removed" test ! -e "${REPO_ROOT}/third_party/libnbd-rust"

# Any Cargo command that reads a separate source tree needs that tree prepared,
# because the pinned bindings are no longer committed to this repository.
check_workflow_source_preparation() {
    local workflow match line_number rest root total=0
    while IFS= read -r workflow; do
        while IFS= read -r match; do
            line_number="${match%%:*}"
            rest="${match#*:}"
            root="${rest#*--manifest-path \"}"; root="${root%%/Cargo.toml\"*}"
            [ -n "$root" ] || continue
            total=$((total + 1))
            if head -n "$line_number" "$workflow" | grep -Fq "${root}/tools/image-build/prepare-libnbd-rust.sh"; then
                pass "$(basename "$workflow") prepares ${root} before Cargo"
            else
                fail "$(basename "$workflow") runs Cargo on ${root} without preparing it"
            fi
        done < <(grep -n 'cargo ' "$workflow" | grep -F -- '--manifest-path' || true)
    done < <(find "$WORKFLOW_DIR" -maxdepth 1 -name '*.yml' | LC_ALL=C sort)
    check_equal "separate-source Cargo builds found and prepared" "$total" "1"
}

check_workflow_source_preparation

check_equal "the shared cache is untouched by every fixture case" \
    "$(tree_fingerprint "${REPO_CACHE}/rust")" "$shared_before"

if [ "$failures" -ne 0 ]; then
    printf '\n%d libnbd preparation check(s) failed\n' "$failures" >&2
    exit 1
fi
printf '\nall libnbd preparation checks passed\n'
