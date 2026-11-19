#!/usr/bin/env bash
# qemu.yml, job pin, step "Pin the published QEMU": pin.sh <checksums file>.
# Writes pins.txt for the set these sources build from the checksums of the
# release that was just published.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set_id="$(bash "${here}/set.sh")"
{
  sed -n '/^#/p' "${here}/pins.txt"
  echo "set ${set_id}"
  # intar-qemu_<os>_<arch>.tar.gz, one line per target.
  sed -nE 's/^([0-9a-f]{64})  intar-qemu_([a-z0-9]+)_([a-z0-9]+)\.tar\.gz$/\2 \3 \1/p' "$1" | LC_ALL=C sort
} > "${here}/pins.txt.new"
mv "${here}/pins.txt.new" "${here}/pins.txt"
grep -Eq '^[a-z0-9]+ [a-z0-9]+ [0-9a-f]{64}$' "${here}/pins.txt"
cat "${here}/pins.txt"
