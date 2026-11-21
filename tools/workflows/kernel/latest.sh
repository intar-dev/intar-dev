#!/usr/bin/env bash
# The weekly kernel update job, step "Find the newest kernel".
# Looks for a newer Debian linux source package in trixie and trixie-security,
# in the upstream series kernel.rs pins (6.12.x stays 6.12.x), and finds the
# dated snapshot directory that holds its three files. Prints one JSON object:
#   {"pinned", "version", "upstream", "newer", "base_url",
#    "files": [{"name", "sha256", "size"} for the .dsc, .orig and .debian]}
# bump.py takes that object. With GITHUB_OUTPUT set, newer= and version= are
# written there too. Needs bash, curl, xz, jq and awk.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
rs=crates/intar-image-build/src/kernel.rs

# The first string literal at or after a constant's declaration.
pin() {
  awk -v name="$1" '
    index($0, "pub const " name ":") == 1 { found = 1 }
    found && match($0, /"[^"]*"/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  ' "${rs}"
}
pinned="$(pin KERNEL_SOURCE_VERSION)"
pinned_upstream="$(pin KERNEL_UPSTREAM_VERSION)"
pinned_base_url="$(pin KERNEL_SOURCE_BASE_URL)"
[[ "${pinned}" =~ ^[0-9]+\.[0-9]+[0-9.]*-[0-9A-Za-z.+~]+$ && "${pinned%-*}" == "${pinned_upstream}" ]] \
  || { echo "Cannot read the pinned kernel version from ${rs}." >&2; exit 1; }
IFS=. read -r major minor _ <<< "${pinned_upstream}"
series="${major}.${minor}"

fetch() {
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 "$@"
}

# True when Debian version $1 is newer than $2.
newer_than() {
  if command -v dpkg > /dev/null; then
    dpkg --compare-versions "$1" gt "$2"
  else
    # ponytail: sort -V is not Debian's ordering (~ and epochs differ); it only
    # serves local runs on a machine without dpkg. CI has dpkg.
    [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
  fi
}

# Every linux stanza of both suites as "<version> <sha256> <size> <name>" lines.
stanzas="$(
  for sources in \
    https://deb.debian.org/debian/dists/trixie/main/source/Sources.xz \
    https://security.debian.org/debian-security/dists/trixie-security/main/source/Sources.xz; do
    fetch "${sources}" | xz -dc | awk '
      BEGIN { RS = ""; FS = "\n" }
      {
        package = ""; version = ""
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^Package: /) package = substr($i, 10)
          if ($i ~ /^Version: /) version = substr($i, 10)
        }
        if (package != "linux") next
        listed = 0
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^Checksums-Sha256:/) { listed = 1; continue }
          if (listed && $i ~ /^ /) { split($i, part, " "); print version, part[1], part[2], part[3] }
          else listed = 0
        }
      }'
  done
)"
[ -n "${stanzas}" ] || { echo "Debian's source indexes list no linux package." >&2; exit 1; }

version="${pinned}"
while read -r candidate; do
  [[ "${candidate}" == "${series}."* || "${candidate}" == "${series}-"* ]] || continue
  if newer_than "${candidate}" "${version}"; then version="${candidate}"; fi
done < <(awk '{ print $1 }' <<< "${stanzas}" | sort -u)

if [ "${version}" = "${pinned}" ]; then
  newer=false
  base_url="${pinned_base_url}"
  files="$(awk '
    /^pub const KERNEL_SOURCE_FILES:/ { inside = 1 }
    inside && /^\];/ { exit }
    inside && /name:/ { split($0, part, "\""); name = part[2] }
    inside && /sha256:/ { split($0, part, "\""); sha256 = part[2] }
    inside && /size_bytes:/ { gsub(/[^0-9]/, ""); print name, sha256, $0 }
  ' "${rs}")"
else
  newer=true
  upstream="${version%-*}"
  [[ "${version}" =~ ^[0-9]+\.[0-9]+[0-9.]*-[0-9A-Za-z.+~]+$ ]] \
    || { echo "Debian's version '${version}' is not one this script understands." >&2; exit 1; }
  # In the order kernel.rs keeps them: .dsc, .orig, .debian.
  files="$(
    for name in "linux_${version}.dsc" "linux_${upstream}.orig.tar.xz" "linux_${version}.debian.tar.xz"; do
      awk -v version="${version}" -v name="${name}" \
        '$1 == version && $4 == name && !seen++ { print $4, $2, $3 }' <<< "${stanzas}"
    done
  )"
  # The moving pool drops a version once a newer one lands (#288), so the pin
  # is the pool of the first snapshot that holds all three files.
  base_url="$(
    fetch "https://snapshot.debian.org/mr/package/linux/${version}/srcfiles?fileinfo=1" \
      | jq -er --arg names "$(awk '{ print $1 }' <<< "${files}")" '
        ($names | split("\n")) as $names
        | [.fileinfo[][]
            | select(.archive_name | endswith("-debug") | not)
            | select(.name as $name | $names | index($name))]
        | group_by([.archive_name, .path])
        | map(select((map(.name) | unique | length) == 3)
            | {archive: .[0].archive_name, path: .[0].path,
               seen: (group_by(.name) | map(map(.first_seen) | min) | max)})
        | sort_by(.seen)
        | .[0]
        | "https://snapshot.debian.org/archive/\(.archive)/\(.seen)\(.path)"'
  )" || { echo "snapshot.debian.org does not hold all of linux ${version} yet." >&2; exit 1; }
  [[ "${base_url}" =~ ^https://snapshot\.debian\.org/archive/[a-z-]+/[0-9]{8}T[0-9]{6}Z/[A-Za-z0-9/._+-]+$ ]] \
    || { echo "Unexpected snapshot directory: ${base_url}" >&2; exit 1; }
  while read -r name _; do
    fetch --head --output /dev/null "${base_url}/${name}" \
      || { echo "${base_url}/${name} is not there." >&2; exit 1; }
  done <<< "${files}"
fi
[ "$(wc -l <<< "${files}")" -eq 3 ] || { echo "Expected three source files of linux ${version}, found:" >&2; echo "${files}" >&2; exit 1; }

jq -n --arg pinned "${pinned}" --arg version "${version}" --arg upstream "${version%-*}" \
  --argjson newer "${newer}" --arg base_url "${base_url}" --arg files "${files}" '{
    $pinned, $version, $upstream, $newer, $base_url,
    files: [$files | split("\n")[] | split(" ") | {name: .[0], sha256: .[1], size: (.[2] | tonumber)}]
  }'
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'newer=%s\nversion=%s\n' "${newer}" "${version}" >> "${GITHUB_OUTPUT}"
fi
