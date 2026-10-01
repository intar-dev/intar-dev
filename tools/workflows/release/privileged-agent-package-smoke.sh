#!/usr/bin/env bash
# release.yml, job build, step "Run privileged agent package smoke".
set -euo pipefail
package_root="$(mktemp -d)"
tar -xzf "dist/intar-agent_${VERSION}_linux_amd64.tar.gz" -C "${package_root}"
# Use the installer's minimum-version validation and install path.
sudo python3 - "${package_root}" <<'PY'
from pathlib import Path
import runpy, sys
package = Path(sys.argv[1])
installer = runpy.run_path(str(package / 'deploy/personal-metal/intar-host'))
installer['install_dependencies'](package)
PY
if ! id intar-agent >/dev/null 2>&1; then
  sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin intar-agent
fi
sudo sh deploy/personal-metal/test-mounts-linux.sh
sudo sh crates/intar-jailerd/tests/package-smoke.sh \
  "${PWD}/dist/intar-agent_${VERSION}_linux_amd64.tar.gz"
rm -rf "${package_root}"
