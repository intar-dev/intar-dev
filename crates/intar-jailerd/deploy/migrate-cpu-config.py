#!/usr/bin/env python3
"""Migrate only the removed CPU settings after the installer proves drain."""

import copy
import os
import re
import shutil
import stat
import tempfile
import tomllib
from pathlib import Path


def migrate(text: str, kind: str) -> str:
    before = tomllib.loads(text)
    expected = copy.deepcopy(before)
    if kind == "jailerd":
        expected.pop("boot_cpu_millis", None)
        expected.pop("boot_cpu_lease_ms", None)
    else:
        resources = expected.get("vm_defaults", {}).get("resources", {})
        count = resources.pop("vcpus", None)
        if count is not None:
            if type(count) is not int or count <= 0:
                raise ValueError("legacy vcpus must be a positive integer")
            if resources.get("cpu_millis", count * 1000) != count * 1000:
                raise ValueError("cpu_millis conflicts with legacy vcpus")
            resources["cpu_millis"] = count * 1000
    if expected == before:
        return text

    section = ""
    lines = []
    for line in text.splitlines(keepends=True):
        table = re.match(r"\s*\[([^\]]+)\]", line)
        if table:
            section = table[1].replace(" ", "")
        if kind == "jailerd" and not section and re.match(
            r"\s*boot_cpu_(millis|lease_ms)\s*=", line
        ):
            continue
        if kind == "agent" and section == "vm_defaults.resources" and re.match(
            r"\s*vcpus\s*=", line
        ):
            resources = before["vm_defaults"]["resources"]
            if "cpu_millis" in resources:
                continue
            comment = line.partition("#")[2].rstrip("\r\n")
            line = f"cpu_millis = {resources['vcpus'] * 1000}"
            line += f" # {comment.lstrip()}\n" if comment else "\n"
        lines.append(line)
    result = "".join(lines)
    if tomllib.loads(result) != expected:
        raise ValueError("CPU configuration uses an unsupported TOML spelling")
    return result


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("CPU configuration migration requires root")
    changes = []
    for kind in ("jailerd", "agent"):
        path = Path(f"/etc/intar-{kind}/config.toml")
        if not path.exists() and not path.is_symlink():
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit(f"untrusted configuration: {path}")
        current = path.read_text()
        updated = migrate(current, kind)
        if updated != current:
            changes.append((kind, path, info, updated))
    if not changes:
        return
    root = Path("/var/lib/intar/config-backups")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise SystemExit("untrusted CPU configuration backup directory")
    backup = Path(tempfile.mkdtemp(prefix="cpu-v4-", dir=root))
    for kind, path, _, _ in changes:
        shutil.copy2(path, backup / f"{kind}.toml")
    for _, path, info, updated in changes:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode))
                os.fchown(output.fileno(), info.st_uid, info.st_gid)
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
    print(f"CPU configuration backup: {backup}")


if __name__ == "__main__":
    main()
