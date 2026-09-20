#!/bin/sh
# Add personal-host assets to the existing intar-agent release staging directory.
set -eu
[ "$#" -eq 2 ] || { echo 'usage: package.sh STAGING VERSION' >&2; exit 2; }
staging=$1
version=$2
python3 - "$version" <<'PY'
import re
import sys
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', sys.argv[1])
PY
install -d -m 0755 "$staging/deploy/personal-metal"
install -m 0755 deploy/personal-metal/intar-host "$staging/deploy/personal-metal/intar-host"
install -m 0644 deploy/personal-metal/README.md "$staging/deploy/personal-metal/README.md"
install -m 0644 apps/web/public/install.sh "$staging/deploy/personal-metal/install.sh"
# apt authenticates the repository metadata. Save exact versions in the release.
# Missing versions fail closed; publish a new agent package when Ubuntu retires them.
python3 - "$staging/deploy/personal-metal/dependencies.lock" <<'PY'
from pathlib import Path
import re
import subprocess
import sys
packages = ('acl', 'ca-certificates', 'coreutils', 'curl', 'dosfstools', 'e2fsprogs',
            'findutils', 'gawk', 'grep', 'gzip', 'iproute2', 'kmod', 'nftables',
            'passwd', 'python3', 'sed', 'tar', 'util-linux', 'xfsprogs')
locked = []
for package in packages:
    policy = subprocess.check_output(['apt-cache', 'policy', package], text=True, env={'PATH': '/usr/bin:/usr/sbin:/bin:/sbin', 'LC_ALL': 'C'})
    match = re.search(r'^\s+Candidate: (\S+)$', policy, re.M)
    if match is None or match[1] == '(none)':
        raise SystemExit(f'No Ubuntu dependency version available: {package}')
    locked.append(f'{package}={match[1]}')
Path(sys.argv[1]).write_text('\n'.join(locked) + '\n')
PY
