#!/usr/bin/env python3
"""Drop the configuration keys the current release retired.

The new binaries refuse unknown keys, so an existing host config must lose
exactly these keys and nothing else. Lines are removed in place, so every
other value and comment stays; the result must parse to the old values minus
the retired keys, otherwise nothing is written.

    migrate-epoch-config.py jailerd|builder          migrate /etc/intar-<kind>/config.toml
    migrate-epoch-config.py jailerd|builder --print  print the migrated file, write nothing

Before the first change the file is copied to config.toml.pre-epoch (0600,
root) for a rollback; an existing copy is never replaced. A second run finds
nothing to drop and changes nothing. deploy/install.sh runs it for jailerd,
the builder rollout for the builder.
"""

import copy
import os
import re
import stat
import sys
import tempfile
import tomllib
from pathlib import Path

# Keys by table ("" is the top level). Only dropped, never renamed, so the
# previous release also reads a migrated file.
RETIRED = {
    "jailerd": {"": {"legacy_template_retention_seconds"}},
    "builder": {
        "qemu": {
            "qemu_storage_daemon_binary",
            "ssh_wait_timeout_seconds",
            "raw_view_read_timeout_seconds",
        },
        "jobs": {"max_attempts"},
    },
}
PATHS = {
    "jailerd": Path("/etc/intar-jailerd/config.toml"),
    "builder": Path("/etc/intar-builder/config.toml"),
}
BACKUP_NAME = "config.toml.pre-epoch"


def migrate(text: str, kind: str) -> str:
    """The config without the retired keys; `text` itself when it has none."""
    retired = RETIRED[kind]
    before = tomllib.loads(text)
    expected = copy.deepcopy(before)
    for table, keys in retired.items():
        node = expected
        for part in table.split(".") if table else []:
            node = node.get(part) if isinstance(node, dict) else None
        if isinstance(node, dict):
            for key in keys:
                node.pop(key, None)
    if expected == before:
        return text

    section = ""
    lines = []
    for line in text.splitlines(keepends=True):
        header = re.match(r"\s*\[([^\[\]]+)\]\s*(#.*)?$", line)
        if header:
            section = ".".join(part.strip() for part in header[1].split("."))
        else:
            key = re.match(r"\s*([A-Za-z0-9_-]+)\s*=", line)
            if key and key[1] in retired.get(section, ()):
                continue
        lines.append(line)
    result = "".join(lines)
    if tomllib.loads(result) != expected:
        raise ValueError("a retired key uses a TOML spelling this migration does not edit")
    return result


def write_atomically(path: Path, data: str, mode: int, uid: int, gid: int, replace: bool) -> bool:
    """Writes `data` to `path` through a temporary file in its directory.

    With `replace` false an existing `path` is left alone and False returned.
    """
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchmod(output.fileno(), mode)
            os.fchown(output.fileno(), uid, gid)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
            if replace:
                os.replace(temporary, path)
            else:
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    return False
        finally:
            temporary.unlink(missing_ok=True)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return True


def migrate_file(path: Path, kind: str, owner: int = 0, group: int = 0) -> bool:
    """Migrates one config file owned by `owner`; True when it changed.

    The rollback copy belongs to `owner` and `group`; the file keeps its own
    owner, group and mode.
    """
    if not path.exists() and not path.is_symlink():
        return False
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != owner or info.st_mode & 0o022:
        raise SystemExit(f"untrusted configuration: {path}")
    current = path.read_text()
    try:
        updated = migrate(current, kind)
    except (tomllib.TOMLDecodeError, ValueError) as error:
        raise SystemExit(f"{path} was left unchanged: {error}") from None
    if updated == current:
        return False
    backup = path.with_name(BACKUP_NAME)
    if not write_atomically(backup, current, 0o600, owner, group, replace=False):
        print(f"kept the existing {backup}")
    write_atomically(path, updated, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, replace=True)
    print(f"dropped retired keys from {path}; the previous file is {backup}")
    return True


def main(argv: list[str]) -> None:
    if len(argv) not in (2, 3) or argv[1] not in PATHS or argv[2:] not in ([], ["--print"]):
        raise SystemExit(f"usage: {argv[0]} jailerd|builder [--print]")
    kind, path = argv[1], PATHS[argv[1]]
    if argv[2:] == ["--print"]:
        try:
            sys.stdout.write(migrate(path.read_text(), kind))
        except (tomllib.TOMLDecodeError, ValueError) as error:
            raise SystemExit(f"{path} cannot be migrated: {error}") from None
        return
    if os.geteuid() != 0:
        raise SystemExit("configuration migration requires root")
    migrate_file(path, kind)


if __name__ == "__main__":
    main(sys.argv)
