#!/usr/bin/env bash
# qemu.yml, job publish, step "Write the checksums".
# One checksums file for every target's archive and the sources: what the
# attestation covers and what a pin is copied from.
set -euo pipefail
cd dist
sha256sum intar-qemu_*.tar.gz intar-qemu_sources.tar > intar-qemu_checksums.txt
cat intar-qemu_checksums.txt
