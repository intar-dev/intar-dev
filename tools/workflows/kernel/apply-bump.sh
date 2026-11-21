#!/usr/bin/env bash
# kernel.yml, jobs build and pin, step "Take the kernel source this run builds".
# Applies the bump the check job decided on, from its kept JSON, so every job
# of a run builds the same source. Nothing happens when nothing is newer.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
latest="${RUNNER_TEMP}/kernel-bump/latest.json"
if [ "$(jq -r .newer "${latest}")" = true ]; then
  python3 "${here}/bump.py" "${latest}"
fi
