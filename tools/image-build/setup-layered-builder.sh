#!/usr/bin/env bash
# Install and run the isolated tools used by the layered image-build candidate.
# This script never changes /usr/local/bin, systemd units, or builder config.
set -euo pipefail

readonly PREFIX="/var/lib/intar-builder/layered-tools"
readonly BIN_DIR="$PREFIX/bin"
readonly RELEASE_DIR="$PREFIX/releases"
readonly INSTALLATION_RECORD="$PREFIX/INSTALLATION.txt"

readonly OCI_CACHE_ROOT="/var/cache/intar-builder/layered-proof/oci"
readonly DAEMON_ROOT="$OCI_CACHE_ROOT/buildkitd"
readonly SOCKET="$OCI_CACHE_ROOT/buildkitd.sock"
readonly PID_FILE="$OCI_CACHE_ROOT/buildkitd.pid"
readonly LOG_FILE="$OCI_CACHE_ROOT/buildkitd.log"
readonly DAEMON_CONFIG="$PREFIX/buildkitd.toml"

readonly BUILDKIT_VERSION="v0.30.0"
readonly BUILDKIT_ARCHIVE="buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz"
readonly BUILDKIT_URL="https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/${BUILDKIT_ARCHIVE}"
readonly BUILDKIT_ARCHIVE_SHA256="2da148c50540409988c837e62b72176e4a9ad7855548a2dd6ea1cd0c0d2d360d"
readonly BUILDKIT_RELEASE_DIR="$RELEASE_DIR/buildkit-${BUILDKIT_VERSION}"

readonly UMOCI_VERSION="v0.6.0"
readonly UMOCI_ASSET="umoci.linux.amd64"
readonly UMOCI_URL="https://github.com/opencontainers/umoci/releases/download/${UMOCI_VERSION}/${UMOCI_ASSET}"
readonly UMOCI_SHA256="b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71"
readonly UMOCI_RELEASE_DIR="$RELEASE_DIR/umoci-${UMOCI_VERSION}"

# BuildKit TOML accepts numeric disk limits as exact bytes. Keep its 6 GiB
# worker cap plus the builder's 2 GiB converted-ext4 cache within 8 GiB total.
readonly OCI_CACHE_BYTES="8589934592"
readonly CONVERTED_CACHE_BYTES="2147483648"
readonly BUILDKIT_MAX_USED_BYTES="6442450944"
readonly MINIMUM_FREE_BYTES="21474836480"

readonly BUILDKITD="$BIN_DIR/buildkitd"
readonly BUILDCTL="$BIN_DIR/buildctl"
readonly BUILDKIT_RUNC="$BIN_DIR/buildkit-runc"
readonly UMOCI="$BIN_DIR/umoci"
readonly QEMU_STORAGE_DAEMON="/usr/bin/qemu-storage-daemon"
readonly UMOUNT="/usr/bin/umount"

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: setup-layered-builder.sh [--install|--start|--stop|--status|--cleanup]

Install pinned BuildKit and umoci release assets into the isolated candidate
prefix. --install is the default and does not start a daemon.

--start   install tools, then start a private BuildKit daemon
--stop    stop only the daemon recorded under the candidate OCI cache root
--status  report the candidate tools and daemon status
--cleanup stop the daemon and remove only candidate tool and daemon-state paths
EOF
}

require_root() {
    [ "${EUID}" -eq 0 ] || die "run this script with sudo"
}

require_host() {
    [ "$(uname -m)" = "x86_64" ] || die "the pinned tool assets require x86_64"
    for tool in curl sha256sum tar install mktemp nohup ldd; do
        command -v "$tool" >/dev/null || die "missing required host tool '$tool'"
    done
    [ -x "$QEMU_STORAGE_DAEMON" ] || die "missing QEMU storage daemon '$QEMU_STORAGE_DAEMON'"
    [ -x "$UMOUNT" ] || die "missing unmount tool '$UMOUNT'"
    [ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ] \
        || die "missing or inaccessible FUSE device '/dev/fuse'"
    ldd "$QEMU_STORAGE_DAEMON" | grep -Eq "libfuse3\.so\.[0-9]+" \
        || die "QEMU storage daemon must link libfuse3"
}

release_is_installed() {
    [ -x "$BUILDKITD" ] && [ -x "$BUILDCTL" ] && [ -x "$BUILDKIT_RUNC" ] && [ -x "$UMOCI" ] \
        && [ -f "$INSTALLATION_RECORD" ] \
        && grep -Fqx "buildkit_version=${BUILDKIT_VERSION}" "$INSTALLATION_RECORD" \
        && grep -Fqx "buildkit_archive_sha256=${BUILDKIT_ARCHIVE_SHA256}" "$INSTALLATION_RECORD" \
        && grep -Fqx "umoci_version=${UMOCI_VERSION}" "$INSTALLATION_RECORD" \
        && grep -Fqx "umoci_sha256=${UMOCI_SHA256}" "$INSTALLATION_RECORD"
}

verify_sha256() {
    local expected="$1"
    local path="$2"
    printf '%s  %s\n' "$expected" "$path" | sha256sum --check --status \
        || die "checksum verification failed for '$path'"
}

download() {
    local url="$1"
    local output="$2"
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error \
        --output "$output" "$url"
}

install_tools() {
    if release_is_installed; then
        printf 'layered tools already installed at %s\n' "$PREFIX"
        return
    fi

    install -d -m 0755 "$PREFIX" "$BIN_DIR" "$RELEASE_DIR"
    local staging
    staging="$(mktemp -d "$PREFIX/.install.XXXXXX")"
    trap 'rm -rf -- "$staging"' EXIT

    local buildkit_archive="$staging/$BUILDKIT_ARCHIVE"
    local umoci_asset="$staging/$UMOCI_ASSET"
    download "$BUILDKIT_URL" "$buildkit_archive"
    verify_sha256 "$BUILDKIT_ARCHIVE_SHA256" "$buildkit_archive"
    download "$UMOCI_URL" "$umoci_asset"
    verify_sha256 "$UMOCI_SHA256" "$umoci_asset"

    mkdir -p "$staging/buildkit-extract"
    tar -xzf "$buildkit_archive" -C "$staging/buildkit-extract"
    for tool in buildkitd buildctl buildkit-runc; do
        [ -f "$staging/buildkit-extract/bin/$tool" ] \
            || die "BuildKit archive is missing '$tool'"
    done

    rm -rf -- "$BUILDKIT_RELEASE_DIR" "$UMOCI_RELEASE_DIR"
    install -d -m 0755 "$BUILDKIT_RELEASE_DIR/bin" "$UMOCI_RELEASE_DIR"
    for tool in buildkitd buildctl buildkit-runc; do
        install -m 0755 "$staging/buildkit-extract/bin/$tool" "$BUILDKIT_RELEASE_DIR/bin/$tool"
    done
    install -m 0755 "$umoci_asset" "$UMOCI_RELEASE_DIR/umoci"

    ln -sfn "../releases/buildkit-${BUILDKIT_VERSION}/bin/buildkitd" "$BUILDKITD"
    ln -sfn "../releases/buildkit-${BUILDKIT_VERSION}/bin/buildctl" "$BUILDCTL"
    ln -sfn "../releases/buildkit-${BUILDKIT_VERSION}/bin/buildkit-runc" "$BUILDKIT_RUNC"
    ln -sfn "../releases/umoci-${UMOCI_VERSION}/umoci" "$UMOCI"

    {
        printf 'buildkit_version=%s\n' "$BUILDKIT_VERSION"
        printf 'buildkit_source=%s\n' "$BUILDKIT_URL"
        printf 'buildkit_archive_sha256=%s\n' "$BUILDKIT_ARCHIVE_SHA256"
        printf 'umoci_version=%s\n' "$UMOCI_VERSION"
        printf 'umoci_source=%s\n' "$UMOCI_URL"
        printf 'umoci_sha256=%s\n' "$UMOCI_SHA256"
        printf 'installed_binary_sha256:\n'
        sha256sum "$BUILDKITD" "$BUILDCTL" "$BUILDKIT_RUNC" "$UMOCI"
    } >"$staging/INSTALLATION.txt"
    install -m 0644 "$staging/INSTALLATION.txt" "$INSTALLATION_RECORD"
    trap - EXIT
    rm -rf -- "$staging"

    printf 'installed BuildKit %s and umoci %s at %s\n' "$BUILDKIT_VERSION" "$UMOCI_VERSION" "$PREFIX"
}

available_bytes() {
    df -B1 --output=avail "$OCI_CACHE_ROOT" | tail -n 1 | tr -d '[:space:]'
}

ensure_free_space() {
    local available
    available="$(available_bytes)"
    [ -n "$available" ] || die "could not determine free space for '$OCI_CACHE_ROOT'"
    [ "$available" -ge "$MINIMUM_FREE_BYTES" ] || die "'$OCI_CACHE_ROOT' has less than the required 20 GiB free"
}

verify_cache_budget() {
    [ "$((BUILDKIT_MAX_USED_BYTES + CONVERTED_CACHE_BYTES))" -eq "$OCI_CACHE_BYTES" ] \
        || die "BuildKit and converted-image cache budgets do not equal 8 GiB"
}

write_daemon_config() {
    local staging
    staging="$(mktemp "$PREFIX/.buildkitd.toml.XXXXXX")"
    {
        printf '%s\n' '# Generated by setup-layered-builder.sh. This is a test-only daemon config.'
        printf '%s\n' '[worker.oci]'
        printf '%s\n' '  enabled = true'
        printf '%s\n' '  gc = true'
        printf '  binary = "%s"\n' "$BUILDKIT_RUNC"
        printf '%s\n' '  max-parallelism = 2'
        printf '  maxUsedSpace = %s\n' "$BUILDKIT_MAX_USED_BYTES"
        printf '  minFreeSpace = %s\n' "$MINIMUM_FREE_BYTES"
        printf '\n[worker.containerd]\n'
        printf '%s\n' '  enabled = false'
    } >"$staging"
    install -m 0644 "$staging" "$DAEMON_CONFIG"
    rm -f -- "$staging"
}

recorded_daemon_is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid="$(cat "$PID_FILE")"
    case "$pid" in
        ''|*[!0-9]*) return 1 ;;
    esac
    kill -0 "$pid" 2>/dev/null || return 1
    local command_line
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    [[ "$command_line" == *"$BUILDKITD"* && "$command_line" == *"--root $DAEMON_ROOT"* && "$command_line" == *"--addr unix://$SOCKET"* ]]
}

verify_daemon() {
    [ -S "$SOCKET" ] || return 1
    "$BUILDCTL" --addr "unix://$SOCKET" debug workers >/dev/null 2>&1
}

start_daemon() {
    install_tools
    install -d -m 0755 "$OCI_CACHE_ROOT"
    install -d -m 0700 "$DAEMON_ROOT"
    verify_cache_budget
    ensure_free_space
    write_daemon_config

    if recorded_daemon_is_running; then
        verify_daemon || die "the recorded candidate BuildKit daemon is not ready"
        printf 'candidate BuildKit daemon is already running at %s\n' "$SOCKET"
        return
    fi
    rm -f -- "$PID_FILE" "$SOCKET"
    (
        umask 077
        nohup "$BUILDKITD" --config "$DAEMON_CONFIG" --root "$DAEMON_ROOT" \
            --addr "unix://$SOCKET" >"$LOG_FILE" 2>&1 < /dev/null &
        printf '%s\n' "$!" >"$PID_FILE"
    )

    local attempt
    for attempt in $(seq 1 30); do
        if recorded_daemon_is_running && verify_daemon; then
            printf 'started candidate BuildKit daemon at %s\n' "$SOCKET"
            return
        fi
        sleep 1
    done
    stop_daemon || true
    die "candidate BuildKit daemon did not become ready; inspect '$LOG_FILE'"
}

stop_daemon() {
    if ! recorded_daemon_is_running; then
        rm -f -- "$PID_FILE" "$SOCKET"
        printf 'candidate BuildKit daemon is not running\n'
        return
    fi

    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid"
    local attempt
    for attempt in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill -0 "$pid" 2>/dev/null && die "candidate BuildKit daemon did not stop cleanly"
    rm -f -- "$PID_FILE" "$SOCKET"
    printf 'stopped candidate BuildKit daemon\n'
}

status() {
    if release_is_installed; then
        printf 'tools: %s\n' "$PREFIX"
        "$BUILDKITD" --version
        "$BUILDCTL" --version
        "$UMOCI" --version
    else
        printf 'tools: not installed\n'
    fi
    if recorded_daemon_is_running && verify_daemon; then
        printf 'daemon: ready at %s\n' "$SOCKET"
    else
        printf 'daemon: stopped\n'
    fi
}

cleanup() {
    stop_daemon
    rm -rf -- "$PREFIX" "$DAEMON_ROOT"
    rm -f -- "$LOG_FILE" "$PID_FILE" "$SOCKET"
    printf 'removed candidate tool prefix %s and daemon state %s\n' "$PREFIX" "$DAEMON_ROOT"
    printf 'left the candidate OCI cache root %s in place\n' "$OCI_CACHE_ROOT"
}

main() {
    require_root
    require_host
    local action="install"
    case "${1:---install}" in
        --install) action="install" ;;
        --start) action="start" ;;
        --stop) action="stop" ;;
        --status) action="status" ;;
        --cleanup) action="cleanup" ;;
        --help|-h) usage; return ;;
        *) usage; die "unknown option '${1}'" ;;
    esac
    [ "$#" -le 1 ] || die "only one option is supported"

    case "$action" in
        install) install_tools ;;
        start) start_daemon ;;
        stop) stop_daemon ;;
        status) status ;;
        cleanup) cleanup ;;
    esac
}

main "$@"
