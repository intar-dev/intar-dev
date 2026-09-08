#!/usr/bin/env python3
"""Prove that umoci and mke2fs preserve required OCI filesystem metadata.

This creates a two-layer OCI layout from Python standard-library tar files. It
does not pull an image, start BuildKit, mount a filesystem, or use production
image data.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, Optional


OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
OCI_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar"
OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
TAG = "metadata-proof"
UID = 1234
GID = 2345
# VFS_CAP_REVISION_2 | VFS_CAP_FLAGS_EFFECTIVE, CAP_NET_BIND_SERVICE permitted.
CAPABILITY = struct.pack("<IIIII", 0x02000001, 1 << 10, 0, 0, 0)


class ProofError(RuntimeError):
    """A failed fixture, tool invocation, or metadata check."""


class Proof:
    def __init__(self) -> None:
        self.checks: list[dict[str, Any]] = []
        self.commands: list[dict[str, Any]] = []

    def check(self, name: str, expected: Any, actual: Any, passed: bool) -> None:
        self.checks.append(
            {"name": name, "expected": expected, "actual": actual, "passed": passed}
        )

    def require(self, name: str, expected: Any, actual: Any, passed: bool) -> None:
        self.check(name, expected, actual, passed)
        if not passed:
            raise ProofError(f"check failed: {name}")

    def run(self, command: list[str], *, cwd: Optional[Path] = None) -> str:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
        )
        evidence = {
            "command": command,
            "returncode": completed.returncode,
            "stdout": completed.stdout[-4000:],
            "stderr": completed.stderr[-4000:],
        }
        self.commands.append(evidence)
        if completed.returncode != 0:
            raise ProofError(
                f"command failed ({completed.returncode}): {' '.join(command)}\n"
                f"{completed.stderr[-1000:]}"
            )
        return completed.stdout + completed.stderr


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--umoci",
        type=Path,
        default=Path("/var/lib/intar-builder/layered-tools/bin/umoci"),
    )
    result.add_argument("--mke2fs", type=Path, default=Path("/usr/sbin/mke2fs"))
    result.add_argument("--debugfs", type=Path, default=Path("/usr/sbin/debugfs"))
    result.add_argument(
        "--report-root",
        type=Path,
        default=Path("/var/lib/intar-builder/layered-proof/metadata"),
    )
    result.add_argument(
        "--keep-fixture",
        action="store_true",
        help="keep the controlled OCI layout and ext4 image after the run",
    )
    return result


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def descriptor(data: bytes, media_type: str) -> dict[str, Any]:
    digest = hashlib.sha256(data).hexdigest()
    return {"mediaType": media_type, "digest": f"sha256:{digest}", "size": len(data)}


def write_blob(layout: Path, data: bytes, media_type: str) -> dict[str, Any]:
    result = descriptor(data, media_type)
    blob = layout / "blobs" / "sha256" / result["digest"].split(":", 1)[1]
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(data)
    return result


def tar_info(name: str, mode: int, uid: int, gid: int, entry_type: bytes) -> tarfile.TarInfo:
    result = tarfile.TarInfo(name)
    result.mode = mode
    result.uid = uid
    result.gid = gid
    result.mtime = 0
    result.type = entry_type
    return result


def add_directory(archive: tarfile.TarFile, name: str) -> None:
    archive.addfile(tar_info(name, 0o755, 0, 0, tarfile.DIRTYPE))


def add_file(
    archive: tarfile.TarFile,
    name: str,
    content: bytes,
    *,
    mode: int = 0o644,
    uid: int = 0,
    gid: int = 0,
    xattrs: dict[str, bytes] | None = None,
) -> None:
    info = tar_info(name, mode, uid, gid, tarfile.REGTYPE)
    info.size = len(content)
    if xattrs:
        # OCI tar layers use SCHILY.xattr.<name> PAX records. The capability
        # fixture bytes are ASCII control bytes, so latin-1 preserves them.
        info.pax_headers = {
            f"SCHILY.xattr.{key}": value.decode("latin-1") for key, value in xattrs.items()
        }
    archive.addfile(info, io.BytesIO(content))


def add_hardlink(archive: tarfile.TarFile, name: str, target: str) -> None:
    info = tar_info(name, 0o640, UID, GID, tarfile.LNKTYPE)
    info.linkname = target
    archive.addfile(info)


def add_symlink(archive: tarfile.TarFile, name: str, target: str) -> None:
    info = tar_info(name, 0o777, UID, GID, tarfile.SYMTYPE)
    info.linkname = target
    archive.addfile(info)


def create_layer_one() -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as archive:
        add_directory(archive, "metadata")
        add_file(archive, "metadata/owned", b"owned metadata\n", mode=0o750, uid=UID, gid=GID)
        add_file(
            archive,
            "metadata/capable",
            b"#!/bin/sh\nexit 0\n",
            mode=0o755,
            uid=UID,
            gid=GID,
            xattrs={"security.capability": CAPABILITY},
        )
        add_directory(archive, "links")
        add_file(archive, "links/hard-a", b"hard link payload\n", mode=0o640, uid=UID, gid=GID)
        add_hardlink(archive, "links/hard-b", "links/hard-a")
        add_symlink(archive, "links/to-owned", "../metadata/owned")
        add_file(archive, "delete-me", b"delete this in layer two\n")
        add_directory(archive, "opaque")
        add_file(archive, "opaque/old-one", b"hidden by opaque whiteout\n")
        add_file(archive, "opaque/old-two", b"hidden by opaque whiteout\n")
    return stream.getvalue()


def create_layer_two() -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as archive:
        add_file(archive, ".wh.delete-me", b"", mode=0)
        add_directory(archive, "opaque")
        add_file(archive, "opaque/.wh..wh..opq", b"", mode=0)
        add_file(archive, "opaque/new-only", b"visible after opaque whiteout\n")
    return stream.getvalue()


def verify_fixture_tar(proof: Proof, layer: bytes) -> None:
    with tarfile.open(fileobj=io.BytesIO(layer), mode="r:") as archive:
        member = archive.getmember("metadata/capable")
        raw = member.pax_headers.get("SCHILY.xattr.security.capability", "").encode("latin-1")
        proof.require("fixture capability PAX bytes", CAPABILITY.hex(), raw.hex(), raw == CAPABILITY)


def make_layout(proof: Proof, work: Path) -> tuple[Path, dict[str, Any]]:
    layout = work / "layout"
    layout.mkdir()
    (layout / "oci-layout").write_bytes(canonical_json({"imageLayoutVersion": "1.0.0"}))
    layer_one = create_layer_one()
    layer_two = create_layer_two()
    verify_fixture_tar(proof, layer_one)
    layer_descriptors = [
        write_blob(layout, layer_one, OCI_LAYER_MEDIA_TYPE),
        write_blob(layout, layer_two, OCI_LAYER_MEDIA_TYPE),
    ]
    config = {
        "architecture": "amd64",
        "config": {},
        "created": "1970-01-01T00:00:00Z",
        "history": [{"created_by": "fixture layer 1"}, {"created_by": "fixture layer 2"}],
        "os": "linux",
        "rootfs": {
            "diff_ids": [entry["digest"] for entry in layer_descriptors],
            "type": "layers",
        },
    }
    config_descriptor = write_blob(layout, canonical_json(config), OCI_CONFIG_MEDIA_TYPE)
    manifest = {
        "config": config_descriptor,
        "layers": layer_descriptors,
        "schemaVersion": 2,
    }
    manifest_bytes = canonical_json(manifest)
    manifest_descriptor = write_blob(layout, manifest_bytes, OCI_MANIFEST_MEDIA_TYPE)
    index = {
        "manifests": [
            {
                **manifest_descriptor,
                "annotations": {"org.opencontainers.image.ref.name": TAG},
            }
        ],
        "schemaVersion": 2,
    }
    (layout / "index.json").write_bytes(canonical_json(index))

    for entry in [*layer_descriptors, config_descriptor, manifest_descriptor]:
        digest = entry["digest"].split(":", 1)[1]
        blob = layout / "blobs" / "sha256" / digest
        actual = hashlib.sha256(blob.read_bytes()).hexdigest()
        proof.require(
            f"OCI blob digest {digest[:12]}",
            digest,
            actual,
            actual == digest and blob.stat().st_size == entry["size"],
        )
    return layout, {
        "manifest_digest": manifest_descriptor["digest"],
        "layer_digests": [entry["digest"] for entry in layer_descriptors],
    }


def metadata(path: Path) -> dict[str, Any]:
    entry = path.lstat()
    return {
        "uid": entry.st_uid,
        "gid": entry.st_gid,
        "mode": f"{stat.S_IMODE(entry.st_mode):04o}",
        "inode": entry.st_ino,
        "nlink": entry.st_nlink,
    }


def require_path_metadata(proof: Proof, prefix: str, path: Path, mode: int) -> dict[str, Any]:
    actual = metadata(path)
    expected = {"uid": UID, "gid": GID, "mode": f"{mode:04o}"}
    proof.require(
        f"{prefix} ownership and mode",
        expected,
        {key: actual[key] for key in expected},
        all(actual[key] == value for key, value in expected.items()),
    )
    return actual


def require_absent(proof: Proof, name: str, path: Path) -> None:
    proof.require(name, "absent", "present" if os.path.lexists(path) else "absent", not os.path.lexists(path))


def verify_rootfs(proof: Proof, rootfs: Path) -> None:
    require_path_metadata(proof, "unpacked owned file", rootfs / "metadata" / "owned", 0o750)
    require_path_metadata(proof, "unpacked capability file", rootfs / "metadata" / "capable", 0o755)
    capability = os.getxattr(rootfs / "metadata" / "capable", "security.capability")
    proof.require(
        "unpacked security.capability", CAPABILITY.hex(), capability.hex(), capability == CAPABILITY
    )
    hard_a = require_path_metadata(proof, "unpacked hardlink source", rootfs / "links" / "hard-a", 0o640)
    hard_b = metadata(rootfs / "links" / "hard-b")
    proof.require(
        "unpacked hardlink inode and count",
        {"same_inode": True, "nlink": 2},
        {"same_inode": hard_a["inode"] == hard_b["inode"], "nlink": hard_a["nlink"]},
        hard_a["inode"] == hard_b["inode"] and hard_a["nlink"] == 2 and hard_b["nlink"] == 2,
    )
    link = rootfs / "links" / "to-owned"
    proof.require(
        "unpacked symlink target",
        "../metadata/owned",
        os.readlink(link),
        link.is_symlink() and os.readlink(link) == "../metadata/owned",
    )
    require_absent(proof, "unpacked normal whiteout deletion", rootfs / "delete-me")
    require_absent(proof, "unpacked opaque old-one deletion", rootfs / "opaque" / "old-one")
    require_absent(proof, "unpacked opaque old-two deletion", rootfs / "opaque" / "old-two")
    proof.require(
        "unpacked opaque directory replacement",
        "present",
        "present" if (rootfs / "opaque" / "new-only").is_file() else "absent",
        (rootfs / "opaque" / "new-only").is_file(),
    )
    require_absent(proof, "unpacked hidden normal whiteout", rootfs / ".wh.delete-me")
    require_absent(proof, "unpacked hidden opaque whiteout", rootfs / "opaque" / ".wh..wh..opq")


def debugfs(proof: Proof, executable: Path, image: Path, request: str) -> str:
    # -c opens the target in catastrophic, read-only mode. No debugfs request
    # below writes to the ext4 image.
    return proof.run([str(executable), "-c", "-R", request, str(image)])


def parse_debugfs_stat(output: str) -> dict[str, Any]:
    inode = re.search(r"Inode:\s+(\d+)", output)
    mode = re.search(r"Mode:\s+([0-7]+)", output)
    owner = re.search(r"User:\s+(\d+)\s+Group:\s+(\d+)", output)
    links = re.search(r"Links:\s+(\d+)", output)
    if not all([inode, mode, owner, links]):
        raise ProofError(f"could not parse debugfs stat output:\n{output}")
    return {
        "inode": int(inode.group(1)),
        "mode": mode.group(1).zfill(4),
        "uid": int(owner.group(1)),
        "gid": int(owner.group(2)),
        "nlink": int(links.group(1)),
    }


def debugfs_stat(proof: Proof, executable: Path, image: Path, path: str) -> dict[str, Any]:
    return parse_debugfs_stat(debugfs(proof, executable, image, f"stat {path}"))


def debugfs_absent(proof: Proof, executable: Path, image: Path, path: str) -> None:
    output = debugfs(proof, executable, image, f"stat {path}")
    proof.require(
        f"ext4 deletion {path}",
        "not found",
        output.strip()[-300:],
        "File not found" in output or "not found" in output.lower(),
    )


def verify_ext4(proof: Proof, executable: Path, rootfs: Path, work: Path) -> Path:
    image = work / "rootfs.ext4"
    proof.run([str(executable), "-q", "-t", "ext4", "-F", "-d", str(rootfs), str(image), "65536"])
    return image


def check_ext4_metadata(proof: Proof, executable: Path, image: Path, work: Path) -> None:
    owned = debugfs_stat(proof, executable, image, "/metadata/owned")
    proof.require(
        "ext4 owned file ownership and mode",
        {"uid": UID, "gid": GID, "mode": "0750"},
        {key: owned[key] for key in ("uid", "gid", "mode")},
        owned["uid"] == UID and owned["gid"] == GID and owned["mode"] == "0750",
    )
    capable = debugfs_stat(proof, executable, image, "/metadata/capable")
    proof.require(
        "ext4 capability file ownership and mode",
        {"uid": UID, "gid": GID, "mode": "0755"},
        {key: capable[key] for key in ("uid", "gid", "mode")},
        capable["uid"] == UID and capable["gid"] == GID and capable["mode"] == "0755",
    )
    hard_a = debugfs_stat(proof, executable, image, "/links/hard-a")
    hard_b = debugfs_stat(proof, executable, image, "/links/hard-b")
    proof.require(
        "ext4 hardlink inode and count",
        {"same_inode": True, "nlink": 2},
        {"same_inode": hard_a["inode"] == hard_b["inode"], "nlink": hard_a["nlink"]},
        hard_a["inode"] == hard_b["inode"] and hard_a["nlink"] == 2 and hard_b["nlink"] == 2,
    )
    symlink_output = debugfs(proof, executable, image, "stat /links/to-owned")
    proof.require(
        "ext4 symlink target",
        "../metadata/owned",
        symlink_output[-500:],
        re.search(r'Fast link dest:\s+"\.\./metadata/owned"', symlink_output) is not None,
    )
    xattr_file = work / "security.capability.bin"
    debugfs(proof, executable, image, f"ea_get -f {xattr_file} /metadata/capable security.capability")
    xattr = xattr_file.read_bytes()
    proof.require("ext4 security.capability", CAPABILITY.hex(), xattr.hex(), xattr == CAPABILITY)
    ea_list = debugfs(proof, executable, image, "ea_list /metadata/capable")
    proof.require(
        "ext4 debugfs lists security.capability",
        "security.capability",
        ea_list[-1000:],
        "security.capability" in ea_list,
    )
    for path in ("/delete-me", "/opaque/old-one", "/opaque/old-two", "/.wh.delete-me", "/opaque/.wh..wh..opq"):
        debugfs_absent(proof, executable, image, path)
    new_only = debugfs_stat(proof, executable, image, "/opaque/new-only")
    proof.require("ext4 opaque directory replacement", "regular inode", new_only["inode"], new_only["inode"] > 0)


def tool_versions(proof: Proof, args: argparse.Namespace) -> dict[str, str]:
    return {
        "umoci": proof.run([str(args.umoci), "--version"]).strip(),
        "mke2fs": proof.run([str(args.mke2fs), "-V"]).strip(),
        "debugfs": proof.run([str(args.debugfs), "-V"]).strip(),
    }


def write_report(root: Path, report: dict[str, Any]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    result = root / f"oci-metadata-proof-{stamp}.json"
    temporary = result.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, result)
    return result


def main() -> int:
    args = parser().parse_args()
    proof = Proof()
    started = time.time()
    report: dict[str, Any] = {"schema_version": 1, "started_at": started, "status": "fail"}
    work: Optional[Path] = None
    try:
        if os.geteuid() != 0:
            raise ProofError("run this controlled metadata proof as root")
        for path in (args.umoci, args.mke2fs, args.debugfs):
            if not path.is_file() or not os.access(path, os.X_OK):
                raise ProofError(f"required executable is unavailable: {path}")
        args.report_root.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=".oci-metadata-", dir=args.report_root))
        report["tools"] = tool_versions(proof, args)
        layout, layout_metadata = make_layout(proof, work)
        bundle = work / "bundle"
        proof.run([str(args.umoci), "unpack", "--image", f"{layout}:{TAG}", str(bundle)])
        verify_rootfs(proof, bundle / "rootfs")
        image = verify_ext4(proof, args.mke2fs, bundle / "rootfs", work)
        check_ext4_metadata(proof, args.debugfs, image, work)
        report.update({"status": "pass", "layout": layout_metadata})
    except Exception as error:  # The result file must describe every test failure.
        report["error"] = str(error)
        report["error_type"] = type(error).__name__
    finally:
        report["finished_at"] = time.time()
        report["checks"] = proof.checks
        report["commands"] = proof.commands
        if work is not None:
            report["fixture_retained"] = args.keep_fixture
            report["fixture_path"] = str(work) if args.keep_fixture else None
        report_path = write_report(args.report_root, report)
        if work is not None and not args.keep_fixture:
            shutil.rmtree(work)
    print(f"OCI metadata proof {report['status']}: {report_path}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
