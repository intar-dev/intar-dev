#!/usr/bin/env bash
# kernel.yml, job check, step "Decide what this run does".
# A scheduled or dispatched run takes Debian's newest kernel source of the
# pinned series: when one is newer than the pin, kernel.rs is bumped in this
# checkout, and the jobs after this one apply the same bump from the kept
# JSON. A pull request's run builds what the pull request holds. Outputs the
# kernel set this source builds, and whether that set still has to be pinned.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bump="${RUNNER_TEMP}/kernel-bump"
mkdir -p "${bump}"
# Always there, so the jobs after this one have something to take.
echo '{"newer": false}' > "${bump}/latest.json"
if [ "${GITHUB_EVENT_NAME}" != pull_request ]; then
  bash "${here}/latest.sh" > "${bump}/latest.json"
  cat "${bump}/latest.json"
  if [ "$(jq -r .newer "${bump}/latest.json")" = true ]; then
    python3 "${here}/bump.py" "${bump}/latest.json"
  fi
fi
inputs="$(cargo run --locked --quiet -p intar-image-build --example kernel_inputs -- amd64 "${RUNNER_TEMP}/kernel-inputs")"
set_id="$(jq -er .set <<< "${inputs}")"
release="$(jq -er .release <<< "${inputs}")"
pinned="$(jq -r '.pinned_sha256 // empty' <<< "${inputs}")"
pin=false
if [ "${GITHUB_EVENT_NAME}" != pull_request ] && [ -z "${pinned}" ]; then
  pin=true
fi
printf 'set=%s\ntag=kernel/v%s\nrelease=%s\npin=%s\n' "${set_id}" "${set_id}" "${release}" "${pin}" | tee -a "${GITHUB_OUTPUT}"
{
  printf '### Guest kernel\n\n- %s, set %s\n' "${release}" "${set_id}"
  printf -- '- this run opens the pull request that pins it: %s\n' "${pin}"
} >> "${GITHUB_STEP_SUMMARY}"
