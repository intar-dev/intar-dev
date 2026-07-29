#!/usr/bin/env bash
set -euo pipefail

readonly workshop_root=/opt/platform-engineering-workshop
cd "${workshop_root}"
test -f /var/lib/intar-workshop/registry-preflight.ok
docker info >/dev/null
for tool in talosctl kubectl helm crane cilium jq git curl; do
  command -v "${tool}" >/dev/null
done
exec ./lab/00-setup/verify.sh
