#!/usr/bin/env bash
# release.yml and ci.yml's release dry run, job build, step "Check the release
# payload".
# What a build leaves in dist/ is what a release publishes, whole: nothing but
# files, each with a name the publish step takes, and each as the product's
# checksums say. The dry run uploads nothing, so this is where it shows.
set -euo pipefail
cd dist
# Values are supplied by the step's reviewed env contract.
# shellcheck disable=SC2153
sums="${BINARY}_${VERSION}_checksums.txt"
[ -f "${sums}" ] || { echo "dist/ has no ${sums}." >&2; exit 1; }
count=0
for entry in * .[!.]*; do
  [ -e "${entry}" ] || [ -L "${entry}" ] || continue
  if [ ! -f "${entry}" ] || [ -L "${entry}" ] || ! [[ "${entry}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "dist/${entry} is not a file a release can publish." >&2
    exit 1
  fi
  count=$((count + 1))
done
if command -v sha256sum > /dev/null; then
  sha256sum --check --strict "${sums}"
else
  shasum -a 256 --check --strict "${sums}"
fi
# Every file but the checksums is named in them.
listed="$(wc -l < "${sums}" | tr -d ' ')"
[ "$((listed + 1))" = "${count}" ] || { echo "dist/ holds ${count} files, and ${sums} names ${listed}." >&2; exit 1; }
