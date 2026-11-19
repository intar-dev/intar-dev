#!/usr/bin/env bash
# qemu.yml, job check, step "Decide what this run does".
# A scheduled or dispatched run takes the newest stable QEMU: when one is
# newer than the pin, sources.txt is bumped in this checkout, and the build
# jobs get that file. A pull request's run builds what the pull request holds.
# Outputs the set these sources build, and whether that set still has to be
# published and pinned.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
version="$(sed -nE 's|^qemu .*/qemu-([0-9.]+)\.tar\.xz .*$|\1|p' "${here}/sources.txt")"
if [ "${GITHUB_EVENT_NAME}" != pull_request ]; then
  bash "${here}/latest.sh" > "${RUNNER_TEMP}/qemu-latest.json"
  cat "${RUNNER_TEMP}/qemu-latest.json"
  if [ "$(jq -r .newer "${RUNNER_TEMP}/qemu-latest.json")" = true ]; then
    bash "${here}/bump.sh" "${RUNNER_TEMP}/qemu-latest.json"
    version="$(jq -er .version "${RUNNER_TEMP}/qemu-latest.json")"
  fi
fi
set_id="$(bash "${here}/set.sh")"
pinned="$(sed -n 's/^set //p' "${here}/pins.txt")"
publish=false pin=false
if [ "${GITHUB_EVENT_NAME}" != pull_request ] && [ "${pinned}" != "${set_id}" ]; then
  pin=true
  # A set that is published but not merged yet is pinned again, not rebuilt.
  [ "$(gh release view "qemu/v${set_id}" --json isDraft --jq .isDraft 2> /dev/null || echo none)" = false ] || publish=true
fi
printf 'version=%s\nset=%s\ntag=qemu/v%s\npublish=%s\npin=%s\n' "${version}" "${set_id}" "${set_id}" "${publish}" "${pin}" | tee -a "${GITHUB_OUTPUT}"
{
  printf '### App QEMU\n\n- QEMU %s, set %s (pinned: %s)\n' "${version}" "${set_id}" "${pinned}"
  printf -- '- this run publishes: %s; opens the pin pull request: %s\n' "${publish}" "${pin}"
} >> "${GITHUB_STEP_SUMMARY}"
