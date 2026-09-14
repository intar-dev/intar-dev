#!/usr/bin/env bash
# Prepare the libnbd inputs Cargo needs before running a Cargo command.
#
# The pinned Rust bindings are prepared on every platform because Cargo cannot
# resolve the workspace while the path dependency is absent. The static C
# library and its pkg-config environment are prepared only for Linux targets,
# which are the only targets that link libnbd.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly BUILD_SCRIPT="${SCRIPT_DIR}/build-libnbd-static.sh"
readonly PREPARE_RUST_SCRIPT="${SCRIPT_DIR}/prepare-libnbd-rust.sh"

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'USAGE'
Usage: with-libnbd-env.sh [--target TARGET] [--rust-only] [--] COMMAND [ARG...]

Prepares the pinned libnbd Rust bindings, then runs COMMAND. A Linux target
also prepares the static libnbd archive and exports its pkg-config environment.
--rust-only skips the static library, which is enough for commands that only
resolve or read the workspace.
USAGE
}

host_target() {
    rustc -vV | awk '/^host: / { print $2 }'
}

target=''
rust_only=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target)
            target="${2:-}"
            [ -n "$target" ] || die '--target requires a value'
            shift 2
            ;;
        --rust-only)
            rust_only=1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        *)
            break
            ;;
    esac
done
[ "$#" -gt 0 ] || die 'a command is required'

"$PREPARE_RUST_SCRIPT"

if [ "$rust_only" -eq 0 ]; then
    if [ -z "$target" ]; then
        target="$(host_target)"
    fi
    case "$target" in
        *-unknown-linux-*)
            build_root="${LIBNBD_BUILD_ROOT:-target/libnbd}/${target}"
            env_file="${build_root}/env.sh"
            "$BUILD_SCRIPT" \
                --target "$target" \
                --prefix "${build_root}/prefix" \
                --env-file "$env_file"
            # shellcheck disable=SC1090
            source "$env_file"
            ;;
        *)
            ;;
    esac
fi
exec "$@"
