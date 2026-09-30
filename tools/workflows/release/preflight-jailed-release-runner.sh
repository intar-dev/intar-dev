#!/usr/bin/env bash
# release.yml, job build, step "Preflight jailed release runner".
set -euo pipefail
test "$(uname -m)" = x86_64
test "$(ps -p 1 -o comm= | tr -d ' ')" = systemd
test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
grep -qw cpu /sys/fs/cgroup/cgroup.controllers
test -c /dev/kvm
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' \
  | sudo tee /etc/udev/rules.d/99-intar-kvm.rules >/dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm
sudo udevadm settle --timeout=30
test -r /dev/kvm
test -w /dev/kvm
test -c /dev/net/tun
test -r /dev/net/tun
test -w /dev/net/tun
python3 - <<'PY'
import ctypes
import os

SYS_LANDLOCK_CREATE_RULESET = 444
LANDLOCK_CREATE_RULESET_VERSION = 1
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
abi = libc.syscall(
    SYS_LANDLOCK_CREATE_RULESET,
    ctypes.c_void_p(),
    ctypes.c_size_t(),
    LANDLOCK_CREATE_RULESET_VERSION,
)
if abi < 3:
    error = ctypes.get_errno()
    detail = os.strerror(error) if error else "unsupported ABI"
    raise SystemExit(
        f"release runner requires Landlock ABI >= 3; got {abi}: {detail}"
    )
print(f"Landlock ABI {abi}")
PY
