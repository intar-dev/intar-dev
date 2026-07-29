#!/usr/bin/env bash
set -euo pipefail
failed=0
check() { if "$@"; then printf 'PASS %s
' "$*"; else printf 'FAIL %s
' "$*" >&2; failed=1; fi; }
check test "$(uname -m)" = x86_64
check grep -q '^VERSION_ID="\?13"\?$' /etc/os-release
check docker info
check test "$(docker info --format '{{.NCPU}}')" -ge 4
check test "$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 ))" -ge 15000
check test -f /var/lib/intar-workshop/registry-preflight.ok
while IFS= read -r image; do
  image="${image%%#*}"; image="${image//[[:space:]]/}"; [[ -z "${image}" ]] && continue
  [[ "${image}" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "FAIL tag-only image ${image}" >&2; failed=1; }
done < /opt/platform-engineering-workshop/scripts/images.lock
for tool in talosctl kubectl helm crane cilium jq git curl; do
  command -v "${tool}" >/dev/null || { echo "FAIL missing ${tool}" >&2; failed=1; }
done
exit "${failed}"
