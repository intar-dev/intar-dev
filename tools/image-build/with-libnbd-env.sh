#!/usr/bin/env bash
# Prepare static libnbd only when the requested Cargo target is Linux.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly BUILD_SCRIPT="${SCRIPT_DIR}/build-libnbd-static.sh"

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

host_target() {
    rustc -vV | awk '/^host: / { print $2 }'
}

target=''
if [ "${1:-}" = '--target' ]; then
    target="${2:-}"
    [ -n "$target" ] || die '--target requires a value'
    shift 2
fi
[ "$#" -gt 0 ] || die 'a command is required'
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
exec "$@"
