#!/bin/sh
# Public entry point. Secrets are read later from /dev/tty by intar-host.
set -eu
set +x
[ "$(id -u)" -eq 0 ] || { echo 'Run: curl -fsSL https://intar.dev/install.sh | sudo sh' >&2; exit 1; }
[ "$#" -eq 0 ] || { echo 'This launcher takes no arguments.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Install Python 3 on Ubuntu 24.04 or later first.' >&2; exit 1; }
exec python3 -I - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request


def get(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'intar-host-installer'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if not response.url.startswith('https://'):
            raise ValueError('HTTPS is required')
        return response.read(4 * 1024 * 1024)


try:
    os.umask(0o077)
    version = None
    for page in range(1, 21):
        releases = json.loads(get(f'https://api.github.com/repos/intar-dev/intar-dev/releases?per_page=100&page={page}'))
        for release in releases:
            match = re.fullmatch(r'agent/v([0-9]+\.[0-9]+\.[0-9]+)', release['tag_name'])
            if match and not release['draft'] and not release['prerelease']:
                version = match[1]
                break
        if version or not releases:
            break
    if not version:
        raise ValueError('No agent release')
    base = f'https://github.com/intar-dev/intar-dev/releases/download/agent%2Fv{version}/'
    name = f'intar-agent_{version}_intar-host'
    sums = get(base + f'intar-agent_{version}_checksums.txt').decode().splitlines()
    matches = [line.split('  ')[0] for line in sums if line.endswith('  ' + name)]
    if len(matches) != 1 or not re.fullmatch('[0-9a-f]{64}', matches[0]):
        raise ValueError('Missing installer checksum')
    script = get(base + name)
    if hashlib.sha256(script).hexdigest() != matches[0]:
        raise ValueError('Installer checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='intar-bootstrap-') as temporary:
        command = Path(temporary) / 'intar-host'
        command.write_bytes(script)
        result = subprocess.run(['/usr/bin/python3', '-I', str(command), 'setup', '--version', version],
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        raise SystemExit(result.returncode)
except (OSError, ValueError, KeyError):
    raise SystemExit('Installer download failed. No token was sent. Repeat the command.')
PY
