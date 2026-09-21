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
import stat
import subprocess
import sys
import tempfile
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('intar_host', sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
host = importlib.util.module_from_spec(spec)
loader.exec_module(host)

with tempfile.TemporaryDirectory(prefix='intar-bind-test-', dir='/run') as temporary:
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

    # Existing loop-backed installs inherit nodev. Repair only the jail bind.
    subprocess.run(['mount', '--bind', str(source), str(source)], check=True)
    try:
        subprocess.run(['mount', '-o', 'remount,bind,nodev,nosuid', str(source)], check=True)
        os.mknod(source / 'null', stat.S_IFCHR | 0o600, os.makedev(1, 3))
        subprocess.run(['mount', '--bind', str(source), str(target)], check=True)
        try:
            try:
                (target / 'null').open('wb').close()
                raise AssertionError('fixture must deny device access')
            except PermissionError:
                pass
            real_run = host.run
            # The test owns an existing mount, with no host systemd changes.
            with patch.object(host, 'UNITS', root / 'units'), patch.object(
                host, 'run', side_effect=lambda *args, **kw:
                    '' if args[0] == 'systemctl' else real_run(*args, **kw)
            ):
                (root / 'units').mkdir()
                host.mount_unit(source, target, 'bind,dev,nosuid')
            (target / 'null').open('wb').close()
            try:
                (source / 'null').open('wb').close()
                raise AssertionError('backing storage must remain nodev')
            except PermissionError:
                pass
        finally:
            subprocess.run(['umount', str(target)], check=True)
    finally:
        subprocess.run(['umount', str(source)], check=True)
print('Native bind-mount regression passed.')
PY
