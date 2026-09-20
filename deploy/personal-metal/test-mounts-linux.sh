#!/bin/sh
# Real same-filesystem bind regression, isolated from the host mount namespace.
set -eu
[ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || {
  echo 'This check requires root on Linux.' >&2
  exit 1
}
manager=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/intar-host
exec unshare --mount --propagation private python3 -I - "${manager}" <<'PY'
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

loader = importlib.machinery.SourceFileLoader('intar_host', sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
host = importlib.util.module_from_spec(spec)
loader.exec_module(host)

with tempfile.TemporaryDirectory(prefix='intar-bind-test-') as temporary:
    root = Path(temporary)
    source, target = root / 'source', root / 'target'
    source.mkdir()
    target.mkdir()
    (source / 'retained-data').write_text('keep')
    subprocess.run(['mount', '--bind', str(source), str(target)], check=True)
    try:
        assert not os.path.ismount(target), 'fixture must reproduce the stat-based detection failure'
        assert host.is_mounted(target), 'mount table must detect the same-filesystem bind'
        assert os.path.samefile(source, target), 'bind source must match'
        assert not host.is_mounted(target / 'retained-data'), 'membership must match an exact mount point'
    finally:
        subprocess.run(['umount', str(target)], check=True)
    assert not host.is_mounted(target), 'unmount must be visible in a new mount-table read'
    assert (source / 'retained-data').read_text() == 'keep'
print('Native bind-mount regression passed.')
PY
