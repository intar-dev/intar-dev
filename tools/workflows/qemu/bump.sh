#!/usr/bin/env bash
# qemu.yml, job check, step "Pin the newer QEMU": bump.sh <latest.sh's JSON>.
# Rewrites the QEMU line of sources.txt to that release. Only a stable
# download.qemu.org tarball that latest.sh checked is taken.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
url="$(jq -er .url "$1")"
digest="$(jq -er .sha256 "$1")"
[[ "${url}" =~ ^https://download\.qemu\.org/qemu-[0-9]+\.[0-9]+\.[0-9]+\.tar\.xz$ && "${digest}" =~ ^[0-9a-f]{64}$ ]]
sed -E "s|^qemu .*$|qemu ${url} ${digest}|" "${here}/sources.txt" > "${here}/sources.txt.new"
mv "${here}/sources.txt.new" "${here}/sources.txt"
grep -c '^qemu ' "${here}/sources.txt" | grep -qx 1
