#!/usr/bin/env bash
# qemu.yml, job pin, step "Pin the published QEMU and open the pull request".
# The release qemu/v<set> holds the files this run (or an earlier one) built
# and boot-tested. Its checksums go into pins.txt, and that change, with the
# bumped sources.txt, becomes the pull request updates/qemu.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[[ "${TAG}" =~ ^qemu/v[0-9a-f]{12}$ && "${QEMU_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[ "qemu/v$(bash "${here}/set.sh")" = "${TAG}" ] || { echo "This checkout does not build ${TAG}." >&2; exit 1; }
sums="${RUNNER_TEMP}/qemu-pin"
rm -rf "${sums}"
gh release download "${TAG}" --pattern intar-qemu_checksums.txt --dir "${sums}"
bash "${here}/pin.sh" "${sums}/intar-qemu_checksums.txt"
body="${RUNNER_TEMP}/qemu-pin-body.md"
{
  # Backticks are Markdown here, so they come in as arguments.
  tick='`' fence='```'
  printf 'The app ships QEMU %s, set %s%s%s.\n\n' "${QEMU_VERSION}" "${tick}" "${TAG#qemu/v}" "${tick}"
  printf 'qemu.yml built it from the sources in %stools/workflows/qemu/sources.txt%s, booted the pinned guest kernel with it, and published it as [%s](https://github.com/%s/releases/tag/%s) with its sources and build provenance. This pull request pins that release; its own run builds and boots the same sources again.\n\n' \
    "${tick}" "${tick}" "${TAG}" "${GITHUB_REPOSITORY}" "${TAG/\//%2F}"
  printf '%s\n' "${fence}"
  cat "${sums}/intar-qemu_checksums.txt"
  printf '%s\n\nBefore merging: start a lab in the app with this QEMU (%scuenv task jumper-qemu%s on this branch).\n' "${fence}" "${tick}" "${tick}"
} > "${body}"
tools/workflows/pins/open-pr.sh updates/qemu "build(jumper): ship QEMU ${QEMU_VERSION} (${TAG#qemu/v})" "${body}" \
  tools/workflows/qemu/sources.txt tools/workflows/qemu/pins.txt
