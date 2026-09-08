#!/usr/bin/env python3
"""Read-only acceptance checks for a completed one-VM published image."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BUILD_CREDENTIAL_PATHS = (
    "/etc/systemd/system/intar-build.service",
    "/etc/systemd/system/intar-build.service.d/10-intar-build-seed.conf",
    "/usr/local/sbin/intar-build-start",
    "/etc/pam.d/intar-build",
    "/home/ubuntu/.ssh/authorized_keys",
    "/root/.ssh/authorized_keys",
    "/run/intar-build-state",
)
ENABLED_UNITS = {
    "acpid.service": "/usr/lib/systemd/system/acpid.service",
    "intar-scenario.service": "/etc/systemd/system/intar-scenario.service",
}


class CheckFailure(RuntimeError):
    pass


class Evidence:
    def __init__(self) -> None:
        self.checks: list[dict[str, Any]] = []
        self.commands: list[dict[str, Any]] = []

    def check(self, name: str, expected: Any, actual: Any, passed: bool) -> None:
        self.checks.append(
            {"name": name, "expected": expected, "actual": actual, "passed": passed}
        )

    def run(self, command: list[str]) -> str:
        completed = subprocess.run(command, check=False, capture_output=True, text=True)
        self.commands.append(
            {
                "command": command,
                "returncode": completed.returncode,
                "stdout": completed.stdout[-2000:],
                "stderr": completed.stderr[-2000:],
            }
        )
        if completed.returncode != 0:
            raise CheckFailure(f"command failed ({completed.returncode}): {' '.join(command)}")
        return completed.stdout + completed.stderr


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disk", type=Path, required=True)
    parser.add_argument("--initrd", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--debugfs", type=Path, default=Path("/usr/sbin/debugfs"))
    parser.add_argument("--unmkinitramfs", type=Path, default=Path("/usr/bin/unmkinitramfs"))
    parser.add_argument(
        "--report-root",
        type=Path,
        default=Path("/var/lib/intar-builder/layered-proof/published-image"),
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stat_snapshot(path: Path) -> dict[str, int]:
    value = path.stat()
    return {"device": value.st_dev, "inode": value.st_ino, "size": value.st_size, "mtime_ns": value.st_mtime_ns}


def debugfs(evidence: Evidence, executable: Path, disk: Path, request: str) -> str:
    # -c opens ext4 in catastrophic read-only mode. No request writes the disk.
    return evidence.run([str(executable), "-c", "-R", request, str(disk)])


def path_missing(evidence: Evidence, executable: Path, disk: Path, path: str, name: str) -> None:
    output = debugfs(evidence, executable, disk, f"stat {path}")
    missing = "File not found" in output or "not found" in output.lower()
    evidence.check(name, "absent", "absent" if missing else "present", missing)


def path_content(evidence: Evidence, executable: Path, disk: Path, path: str) -> str:
    lines = debugfs(evidence, executable, disk, f"cat {path}").splitlines()
    lines = [line for line in lines if not line.startswith("debugfs ")]
    return "\n".join(lines) + ("\n" if lines else "")


def enabled_unit(
    evidence: Evidence, executable: Path, disk: Path, unit: str, target: str
) -> None:
    path = f"/etc/systemd/system/multi-user.target.wants/{unit}"
    output = debugfs(evidence, executable, disk, f"stat {path}")
    match = re.search(r'Fast link dest:\s+"([^"]+)"', output)
    actual = match.group(1) if match else "not a symlink"
    evidence.check(
        f"enabled unit {unit}",
        target,
        actual,
        "Type: symlink" in output and actual == target,
    )


def source_evidence(source_dir: Path) -> dict[str, Any]:
    files = (
        "stage-packages.sh",
        "stage-runtime.sh",
        "stage-cleanup.sh",
        "build.log",
        "disk.commands",
    )
    result: dict[str, Any] = {}
    for name in [*files, *(path.name for path in sorted(source_dir.glob("stage-step-*.sh")))]:
        path = source_dir / name
        if path.is_file():
            result[name] = {"size": path.stat().st_size, "sha256": sha256(path)}
        else:
            result[name] = None
    return result


def check_initrd(evidence: Evidence, unmkinitramfs: Path, initrd: Path, report_root: Path) -> None:
    work = Path(tempfile.mkdtemp(prefix=".initrd-check-", dir=report_root))
    try:
        evidence.run([str(unmkinitramfs), str(initrd), str(work)])
        resume = work / "conf" / "conf.d" / "resume"
        if resume.is_file():
            actual = resume.read_text(encoding="utf-8").strip()
        else:
            actual = "missing"
        evidence.check("initrd resume configuration", "RESUME=none", actual, actual == "RESUME=none")
    finally:
        shutil.rmtree(work)


def write_report(root: Path, report: dict[str, Any]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    scenario_id = re.sub(r"[^A-Za-z0-9._-]", "_", report.get("scenario_id", "unknown"))
    result = root / f"{scenario_id}-published-image-{stamp}-{os.getpid()}.json"
    temporary = result.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, result)
    return result


def main() -> int:
    args = parse_args()
    evidence = Evidence()
    report: dict[str, Any] = {
        "schema_version": 1,
        "status": "fail",
        "started_at": time.time(),
        "inputs": {
            "disk": str(args.disk),
            "initrd": str(args.initrd),
            "manifest": str(args.manifest),
            "source_dir": str(args.source_dir),
        },
    }
    try:
        if os.geteuid() != 0:
            raise CheckFailure("run this image check as root")
        for path in (args.disk, args.initrd, args.manifest, args.debugfs, args.unmkinitramfs):
            if not path.is_file():
                raise CheckFailure(f"required path is unavailable: {path}")
        args.report_root.mkdir(parents=True, exist_ok=True)
        disk_before = stat_snapshot(args.disk)
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        scenario_id = manifest.get("scenario_id")
        if not isinstance(scenario_id, str) or not scenario_id:
            raise CheckFailure("manifest has no scenario_id")
        report["scenario_id"] = scenario_id
        vms = manifest.get("vms")
        if not isinstance(vms, list) or len(vms) != 1:
            count = len(vms) if isinstance(vms, list) else "non-list"
            raise CheckFailure(f"one input disk requires exactly one manifest VM; got {count}")
        vm = vms[0]
        if not isinstance(vm, dict):
            raise CheckFailure("manifest VM must be an object")
        report["manifest"] = {
            "schema_version": manifest.get("schema_version"),
            "vm_count": len(vms),
            "vm_name": vm.get("name"),
        }
        report["source_artifacts"] = source_evidence(args.source_dir)
        for name, artifact in report["source_artifacts"].items():
            evidence.check(
                f"direct build source retained: {name}",
                "present",
                "present" if artifact else "missing",
                artifact is not None,
            )
        report["disk"] = {"path": str(args.disk), **disk_before}
        report["initrd"] = {"path": str(args.initrd), "size": args.initrd.stat().st_size, "sha256": sha256(args.initrd)}
        evidence.check(
            "raw disk size matches manifest",
            vm["image_virtual_size_bytes"],
            disk_before["size"],
            disk_before["size"] == vm["image_virtual_size_bytes"],
        )
        evidence.check(
            "initrd hash matches manifest",
            vm["boot"]["initrd_sha256"],
            report["initrd"]["sha256"],
            report["initrd"]["sha256"] == vm["boot"]["initrd_sha256"],
        )

        resume = path_content(evidence, args.debugfs, args.disk, "/etc/initramfs-tools/conf.d/resume").strip()
        evidence.check("rootfs resume configuration", "RESUME=none", resume, resume == "RESUME=none")
        check_initrd(evidence, args.unmkinitramfs, args.initrd, args.report_root)

        for path in BUILD_CREDENTIAL_PATHS:
            path_missing(evidence, args.debugfs, args.disk, path, f"build credential removed: {path}")
        path_missing(evidence, args.debugfs, args.disk, "/usr/sbin/policy-rc.d", "Docker policy-rc.d removed")

        for unit, target in ENABLED_UNITS.items():
            enabled_unit(evidence, args.debugfs, args.disk, unit, target)
        if scenario_id == "broken-nginx":
            path_missing(
                evidence,
                args.debugfs,
                args.disk,
                "/etc/systemd/system/multi-user.target.wants/nginx.service",
                "Broken Nginx fault leaves nginx disabled",
            )
        disk_after = stat_snapshot(args.disk)
        evidence.check("raw disk stayed unchanged during read-only inspection", disk_before, disk_after, disk_before == disk_after)
        report["status"] = "pass" if all(item["passed"] for item in evidence.checks) else "fail"
    except Exception as error:
        report["error_type"] = type(error).__name__
        report["error"] = str(error)
    finally:
        report["finished_at"] = time.time()
        report["checks"] = evidence.checks
        report["commands"] = evidence.commands
        report_path = write_report(args.report_root, report)
    print(f"published image check {report['status']}: {report_path}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
