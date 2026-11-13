#!/usr/bin/env bash
# Copies the in-repository example into DEST as a repository of the new
# format: intar.hcl, scenarios/broken-nginx and the course Markdown.
# content/ itself still holds base-images.hcl and the old course scenario.hcl,
# which the old builder reads, so it does not validate as a whole.
set -euo pipefail
dest="$1"
src="$(cd "$(dirname "$0")/../.." && pwd)/content"
mkdir -p "${dest}/scenarios"
cp "${src}/intar.hcl" "${dest}/"
cp -R "${src}/scenarios/broken-nginx" "${dest}/scenarios/"
(cd "${src}" && find courses -name '*.md' -print0) | while IFS= read -r -d '' file; do
  mkdir -p "${dest}/$(dirname "${file}")"
  cp "${src}/${file}" "${dest}/${file}"
done
