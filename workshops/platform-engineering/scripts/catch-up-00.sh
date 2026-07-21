#!/usr/bin/env bash
set -euo pipefail

# Upstream's generic catch-up starts at module 02 because it reconciles
# cumulative GitOps application state. Module 00 is instead the immutable
# image preflight: the dedicated Intar base already contains the pinned tools,
# participant repository, local registry, and offline image cache.
readonly workshop_root=/opt/platform-engineering-workshop
cd "${workshop_root}"
export MISE_OFFLINE=1

# Do not install or pull during publication. A missing prerequisite means the
# dedicated base image is invalid and must fail atomically before checkpoint 00
# can be published.
./scripts/install.sh --check
readonly expected_crane_version=0.21.7
readonly crane_version="$(crane version 2>&1 || true)"
[[ "${crane_version}" == *"${expected_crane_version}"* ]] || {
  printf 'expected preinstalled crane %s, got: %s\n' "${expected_crane_version}" "${crane_version}" >&2
  exit 1
}
