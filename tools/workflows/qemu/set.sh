#!/usr/bin/env bash
# The QEMU set these sources build: a digest of sources.txt and build.sh.
# build.sh, fetch.sh and qemu.yml all name a build by it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if command -v sha256sum > /dev/null; then cat "${here}/sources.txt" "${here}/build.sh" | sha256sum; else cat "${here}/sources.txt" "${here}/build.sh" | shasum -a 256; fi | cut -c1-12
