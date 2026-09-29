#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Prepare Kino source workspace" step.
set -euo pipefail
# Cargo resolves the whole workspace of the pinned Kino revision, so a
# revision that does not commit the libnbd bindings needs them
# prepared inside that source tree before any Cargo command reads it.
# Run the script through bash so the checkout's file mode cannot decide
# whether preparation happens.
kino_prepare="${RUNNER_TEMP}/kino-source/tools/image-build/prepare-libnbd-rust.sh"
if [ -f "$kino_prepare" ]; then
  bash "$kino_prepare"
elif [ -f "${RUNNER_TEMP}/kino-source/third_party/libnbd-rust/Cargo.toml" ]; then
  echo 'Kino source revision commits the libnbd bindings; nothing to prepare.'
else
  echo "neither a preparation script nor committed libnbd bindings under ${RUNNER_TEMP}/kino-source" >&2
  exit 1
fi
