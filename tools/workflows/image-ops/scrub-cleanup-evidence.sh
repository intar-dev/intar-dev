#!/usr/bin/env bash
# image-ops workflow, cleanup job, "Remove any response that reflected the machine credential" step.
set -euo pipefail
evidence_dir="${RUNNER_TEMP}/intar-image-registry-cleanup"
[ -d "${evidence_dir}" ] || exit 0
removed=0
# Both machine credentials used by this lane are checked: the bypass
# secret reaches the parent, and the publish token reaches the registry.
for secret in "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET:-}" "${INTAR_IMAGE_PUBLISH_TOKEN:-}"; do
  [ -n "${secret}" ] || continue
  for candidate in "${evidence_dir}"/*; do
    [ -f "${candidate}" ] || continue
    if grep -qF -- "${secret}" "${candidate}" 2>/dev/null; then
      rm -f -- "${candidate}"
      echo "removed a file that reflected a machine credential: ${candidate}" >&2
      removed=1
    fi
  done
done
if [ "${removed}" = 1 ]; then
  echo 'the image registry cleanup evidence reflected a machine credential.' >&2
  exit 1
fi
