#!/usr/bin/env bash
# kernel.yml, job publish, step "Write the checksums".
# One checksums file for both architectures: what the attestation covers and
# what a pin is copied from.
set -euo pipefail
cd dist
sha256sum intar-kernel_amd64.tar.gz intar-kernel_arm64.tar.gz > intar-kernel_checksums.txt
cat intar-kernel_checksums.txt
