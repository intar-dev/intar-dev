#!/usr/bin/env bash
# qemu.yml, job check, step "Look for a newer QEMU"; also run by hand.
# Finds the newest stable QEMU on download.qemu.org. When it is newer than the
# one pinned in sources.txt, its tarball is downloaded and must carry a valid
# signature of the QEMU release key (qemu-release-key.asc, the key qemu.org
# names) before its SHA-256 is taken. Prints one JSON object:
#   {"pinned", "version", "newer", "url", "sha256"}
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fingerprint=CEACC9E15534EBABB82D3FA03353C9CEF108B584
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
read -r _ pinned_url pinned_sha256 < <(grep '^qemu ' "${here}/sources.txt")
pinned="$(sed -E 's|.*/qemu-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.xz$|\1|' <<< "${pinned_url}")"
[[ "${pinned}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]

# Stable releases only: a release candidate is qemu-X.Y.Z-rcN.
listing="$(curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error https://download.qemu.org/)"
latest="$(grep -oE 'qemu-[0-9]+\.[0-9]+\.[0-9]+\.tar\.xz"' <<< "${listing}" | sed -E 's/^qemu-(.*)\.tar\.xz"$/\1/' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
[[ "${latest}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "No stable QEMU release found on download.qemu.org." >&2; exit 1; }
newest="$(printf '%s\n%s\n' "${pinned}" "${latest}" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"

if [ "${newest}" = "${pinned}" ]; then
  version="${pinned}" newer=false url="${pinned_url}" digest="${pinned_sha256}"
else
  version="${latest}" newer=true url="https://download.qemu.org/qemu-${latest}.tar.xz"
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' EXIT
  for file in "qemu-${latest}.tar.xz" "qemu-${latest}.tar.xz.sig"; do
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error --output "${work}/${file}" "https://download.qemu.org/${file}"
  done
  # A keyring of its own with only the release key: a good signature by any
  # other key does not count.
  export GNUPGHOME="${work}/gnupg"
  mkdir -m 700 "${GNUPGHOME}"
  gpg --batch --quiet --no-autostart --import "${here}/qemu-release-key.asc" 2> /dev/null
  status="$(gpg --batch --no-autostart --status-fd 1 --verify "${work}/qemu-${latest}.tar.xz.sig" "${work}/qemu-${latest}.tar.xz" 2> /dev/null || true)"
  grep -q "^\[GNUPG:\] VALIDSIG ${fingerprint} " <<< "${status}" || { echo "qemu-${latest}.tar.xz is not signed by the QEMU release key." >&2; exit 1; }
  digest="$(sha256 "${work}/qemu-${latest}.tar.xz")"
fi
jq -n --arg pinned "${pinned}" --arg version "${version}" --argjson newer "${newer}" --arg url "${url}" --arg sha256 "${digest}" \
  '{pinned: $pinned, version: $version, newer: $newer, url: $url, sha256: $sha256}'
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'newer=%s\nversion=%s\n' "${newer}" "${version}" >> "${GITHUB_OUTPUT}"
fi
