#!/usr/bin/env python3
"""The weekly kernel update job, step "Pin the new source": bump.py LATEST.json.

LATEST.json is what latest.sh printed. Rewrites the source pins in
crates/intar-image-build/src/kernel.rs (the two versions, the snapshot
directory, the three files) and every literal of the old versions in that
crate's sources, tests included (in kernel.rs the patch level on its own
too, as '96', "96" and SUBLEVEL = 96). The derived pins (the artifact set, the two
archive checksums, the platform digest) stay as they are: pin.py writes them
once the new kernels are built, and their tests fail until then.

Refuses another upstream series, a downgrade, and anything but the three files
of the version. Does nothing when the version is already pinned.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "crates/intar-image-build/src"
VERSION = re.compile(r"[0-9]+\.[0-9]+[0-9.]*-[0-9A-Za-z.+~]+")
BASE_URL = re.compile(r"https://snapshot\.debian\.org/archive/[a-z-]+/[0-9]{8}T[0-9]{6}Z/[A-Za-z0-9/._+-]+")


def constant(source: str, name: str) -> str:
    found = re.search(rf'^pub const {name}: &str =\s*"([^"]*)";', source, re.M)
    if not found:
        sys.exit(f"bump.py: kernel.rs has no {name}")
    return found.group(1)


def series(upstream: str) -> str:
    return ".".join(upstream.split(".")[:2])


def is_newer(new: str, old: str) -> bool:
    if shutil.which("dpkg"):
        return subprocess.run(["dpkg", "--compare-versions", new, "gt", old], check=False).returncode == 0
    # ponytail: without dpkg (local runs) the digit runs are compared as
    # numbers, which is not Debian's ordering for ~ and epochs. CI has dpkg.
    def key(version: str) -> list:
        return [int(part) if part.isdigit() else part for part in re.split(r"([0-9]+)", version)]

    return key(new) > key(old)


def replace_once(source: str, pattern: str, replacement: str) -> str:
    result, count = re.subn(pattern, lambda _: replacement, source, flags=re.M | re.S)
    if count != 1:
        sys.exit(f"bump.py: expected one match of {pattern!r} in kernel.rs, found {count}")
    return result


def bump(latest: dict) -> str:
    kernel_rs = SRC / "kernel.rs"
    source = kernel_rs.read_text()
    old = constant(source, "KERNEL_SOURCE_VERSION")
    old_upstream = constant(source, "KERNEL_UPSTREAM_VERSION")

    version, upstream, base_url, files = (latest.get(key) for key in ("version", "upstream", "base_url", "files"))
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        sys.exit(f"bump.py: {version!r} is not a Debian linux version")
    if upstream != version.rpartition("-")[0]:
        sys.exit(f"bump.py: upstream {upstream!r} is not the upstream part of {version}")
    if version == old:
        return f"{old} is already pinned; nothing to do"
    if series(upstream) != series(old_upstream):
        sys.exit(f"bump.py: {version} is not in the pinned {series(old_upstream)} series; refusing")
    if not is_newer(version, old):
        sys.exit(f"bump.py: {version} is older than the pinned {old}; refusing")
    if not isinstance(base_url, str) or not BASE_URL.fullmatch(base_url):
        sys.exit(f"bump.py: {base_url!r} is not a snapshot.debian.org pool directory")
    expected = [f"linux_{version}.dsc", f"linux_{upstream}.orig.tar.xz", f"linux_{version}.debian.tar.xz"]
    if not isinstance(files, list) or sorted(f.get("name", "") for f in files) != sorted(expected):
        sys.exit(f"bump.py: expected exactly the files {', '.join(expected)}")
    by_name = {f["name"]: f for f in files}
    entries = ""
    for name in expected:
        sha256, size = by_name[name].get("sha256"), by_name[name].get("size")
        if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            sys.exit(f"bump.py: {name} has no sha256")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            sys.exit(f"bump.py: {name} has no size")
        entries += (
            "    KernelSourceFile {\n"
            f'        name: "{name}",\n'
            f'        sha256: "{sha256}",\n'
            f"        size_bytes: {size:_},\n"
            "    },\n"
        )

    # One pass over each file, the longer literal first, so the upstream
    # version inside an already replaced source version is never touched again.
    literal = re.compile(rf"(?<![0-9.])(?:{re.escape(old)}|{re.escape(old_upstream)})(?![0-9])")
    for path in sorted(SRC.rglob("*.rs")):
        text = path.read_text()
        bumped = literal.sub(lambda found: version if found.group(0) == old else upstream, text)
        if path == kernel_rs:
            declaration = f'pub const KERNEL_SOURCE_BASE_URL: &str = "{base_url}";'
            # rustfmt breaks after the = only when the literal then fits in its
            # 100 columns; a longer one stays on the declaration's line.
            if len(declaration) > 100 and len(base_url) + 7 <= 100:
                declaration = declaration.replace(" = ", " =\n    ")
            bumped = replace_once(bumped, r'^pub const KERNEL_SOURCE_BASE_URL: &str =\s*"[^"]*";', declaration)
            bumped = replace_once(
                bumped,
                r"^(pub const KERNEL_SOURCE_FILES: &\[KernelSourceFile\] = &\[\n).*?^\];",
                "pub const KERNEL_SOURCE_FILES: &[KernelSourceFile] = &[\n" + entries + "];",
            )
            # kernel.rs's tests also hold the patch level on its own, as the
            # build script's upstream_patch='96' and the Makefile's SUBLEVEL = 96.
            old_patch, patch = old_upstream.split(".")[2:3], upstream.split(".")[2:3]
            if old_patch and patch and old_patch != patch:
                quoted = rf"""(?<=['"]){old_patch[0]}(?=['"])|(?<=SUBLEVEL = ){old_patch[0]}\b"""
                bumped = re.sub(quoted, patch[0], bumped)
        if bumped != text:
            path.write_text(bumped)
    return f"pinned linux {version} (was {old})"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: bump.py <file with latest.sh's JSON>")
    print(bump(json.loads(Path(sys.argv[1]).read_text())))
