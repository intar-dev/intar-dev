#!/usr/bin/env python3
"""Fail-closed preparation for the destructive bridge V6 agent cutover.

This helper is invoked by install.sh while the agent and jailerd admission
boundary are stopped and locked.  It deliberately understands only the V5
and V6 baseline schemas needed to prove that no local workload state exists.
"""

from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:
    print("intar V6 cutover: Python 3.11 or newer is required", file=sys.stderr)
    raise SystemExit(1)


class CutoverError(Exception):
    """An operator-actionable, secret-free cutover failure."""


ALLOWED_CONFIG: dict[str, Any] = {
    "server": {"bind": None},
    "cloud_hypervisor": {"binary": None, "spawn_timeout_seconds": None},
    "jailer": {"socket": None, "request_timeout_seconds": None},
    "bridge": {
        "enabled": None,
        "base_url": None,
        "host_id": None,
        "bootstrap_token": None,
        "heartbeat_interval_seconds": None,
    },
    "ssh_access": {
        "enabled": None,
        "public_port_start": None,
        "public_port_end": None,
        "advertised_host": None,
    },
    "vm_defaults": {
        "tap": None,
        "work_dir": None,
        "resources": {"vcpus": None, "memory_mib": None},
        "network": {"guest_cidr": None, "dns": None},
    },
    "image_registry": {
        "url": None,
        "username": None,
        "password": None,
        "refresh_interval_minutes": None,
    },
    "image_cache": {"max_bytes": None},
}

LEGACY_VM_COLUMNS = {
    "name",
    "state",
    "image_key",
    "image_sha256",
    "created_at_s",
    "updated_at_s",
    "running_at_s",
    "error",
    "root_disk_path",
    "seed_disk_path",
    "mac",
    "lease_duration_seconds",
    "guest_ip",
    "guest_ip_cidr",
    "gateway",
    "bridge_name",
    "ssh_public_port",
    "tap_name",
    "spool_dir",
    "ch_socket_path",
    "ch_pid",
    "kino_vsock_cid",
    "kino_vsock_port",
    "kino_vsock_path",
    "ssh_host_keys_openssh_json",
    "run_id",
    "recording_disk_path",
}
V6_VM_COLUMNS = LEGACY_VM_COLUMNS | {
    "ch_start_time_ticks",
    "host_boot_id",
    "jail_generation",
    "jail_unit_name",
    "jail_cgroup_path",
    "jail_root_path",
    "jail_root_inode",
    "jail_uid",
    "jail_gid",
    "jail_netns_name",
    "cpu_millis",
    "vcpu_count",
    "ch_executable_sha256",
}
WORKLOAD_TABLES = ("vms", "vm_probe_state", "archive_jobs", "desired_state")
AUXILIARY_SCHEMA = {
    "vm_probe_state": {"vm_name", "run_id", "snapshot_json"},
    "archive_jobs": {"run_id", "vm_name", "artifacts_dir"},
    "desired_state": {"id", "host_id", "version", "doc_json"},
    "image_cache_access": {
        "image_sha256",
        "image_key",
        "kernel_sha256",
        "initrd_sha256",
        "raw_bytes",
        "last_accessed_at_ms",
    },
}


def fail(message: str) -> None:
    raise CutoverError(message)


def require_absolute(path: Path, label: str) -> None:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")


def mode_bits(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def validate_directory(
    path: Path,
    *,
    owner_uid: int,
    owner_gid: int | None,
    private: bool,
    label: str,
) -> None:
    try:
        metadata = os.lstat(path)
    except OSError:
        fail(f"{label} directory is missing or unreadable")
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != owner_uid:
        fail(f"{label} must be an owned directory, not a symlink")
    if owner_gid is not None and metadata.st_gid != owner_gid:
        fail(f"{label} has the wrong group")
    forbidden = 0o077 if private else 0o022
    if mode_bits(metadata) & forbidden:
        fail(f"{label} directory permissions are too broad")


def read_config(path: Path, agent_gid: int) -> tuple[bytes, dict[str, Any], os.stat_result]:
    require_absolute(path, "agent config")
    validate_directory(
        path.parent,
        owner_uid=0,
        owner_gid=None,
        private=False,
        label="agent config parent",
    )
    try:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError:
        fail("agent config is missing, unreadable, or a symlink")
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            fail("agent config must be a regular file")
        if metadata.st_uid != 0 or metadata.st_gid != agent_gid:
            fail("agent config must be owned by root and the configured agent group")
        if mode_bits(metadata) not in (0o440, 0o640):
            fail("agent config must have mode 0440 or 0640")
        if metadata.st_nlink != 1:
            fail("agent config must have exactly one hard link")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            content = handle.read()
    finally:
        os.close(fd)
    try:
        parsed = tomllib.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        fail("agent config is not valid UTF-8 TOML")
    if not isinstance(parsed, dict):
        fail("agent config must be a TOML document")
    validate_known_config(parsed, ALLOWED_CONFIG, "")
    return content, parsed, metadata


def validate_known_config(value: dict[str, Any], allowed: dict[str, Any], prefix: str) -> None:
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        location = prefix or "top level"
        fail(f"agent config contains unsupported fields at {location}")
    for key, nested_allowed in allowed.items():
        if key not in value or nested_allowed is None:
            continue
        nested = value[key]
        if not isinstance(nested, dict):
            fail(f"agent config field {prefix}{key} must be a table")
        validate_known_config(nested, nested_allowed, f"{prefix}{key}.")


def config_kind(parsed: dict[str, Any]) -> str:
    section = parsed.get("cloud_hypervisor", {})
    if not isinstance(section, dict):
        fail("agent config cloud_hypervisor value must be a table")
    if "binary" not in section:
        return "current"
    binary = section["binary"]
    if not isinstance(binary, str) or not binary.strip():
        fail("legacy cloud_hypervisor.binary must be a non-empty string")
    return "legacy"


def remove_legacy_binary(content: bytes, parsed: dict[str, Any]) -> bytes:
    # A narrow textual edit preserves comments, ordering, whitespace and every
    # secret-bearing value.  The semantic before/after comparison below proves
    # that this one key is the only TOML value removed.
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        fail("agent config is not valid UTF-8")
    if '"""' in text or "'''" in text:
        fail("multiline TOML strings require manual config migration")

    section: str | None = None
    removed = 0
    transformed: list[str] = []
    section_pattern = re.compile(r"^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$")
    binary_pattern = re.compile(r"^\s*binary\s*=")
    for line in text.splitlines(keepends=True):
        candidate = line.rstrip("\r\n")
        match = section_pattern.fullmatch(candidate)
        if match:
            section = match.group(1)
        if section == "cloud_hypervisor" and binary_pattern.match(candidate):
            removed += 1
            continue
        transformed.append(line)
    if removed != 1:
        fail("legacy cloud_hypervisor.binary must be one standalone assignment")

    output = "".join(transformed).encode("utf-8")
    try:
        after = tomllib.loads(output.decode("utf-8"))
    except tomllib.TOMLDecodeError:
        fail("migrated agent config would not be valid TOML")
    expected = copy.deepcopy(parsed)
    cloud_hypervisor = expected.get("cloud_hypervisor")
    if not isinstance(cloud_hypervisor, dict) or "binary" not in cloud_hypervisor:
        fail("legacy cloud_hypervisor.binary was not found")
    del cloud_hypervisor["binary"]
    if after != expected:
        fail("config migration would change more than cloud_hypervisor.binary")
    validate_known_config(after, ALLOWED_CONFIG, "")
    if config_kind(after) != "current":
        fail("config migration did not remove cloud_hypervisor.binary")
    return output


def validate_database_file(path: Path, agent_uid: int, agent_gid: int) -> os.stat_result:
    require_absolute(path, "agent database")
    validate_directory(
        path.parent,
        owner_uid=agent_uid,
        owner_gid=agent_gid,
        private=False,
        label="agent database parent",
    )
    try:
        metadata = os.lstat(path)
    except OSError:
        fail("agent database is missing or unreadable")
    if not stat.S_ISREG(metadata.st_mode):
        fail("agent database must be a regular file, not a symlink")
    if metadata.st_uid != agent_uid or metadata.st_gid != agent_gid:
        fail("agent database must be owned by the configured agent identity")
    if mode_bits(metadata) & 0o022:
        fail("agent database must not be writable by group or other")
    if metadata.st_nlink != 1:
        fail("agent database must have exactly one hard link")
    return metadata


def validate_sidecars(path: Path, agent_uid: int, agent_gid: int) -> list[Path]:
    sidecars: list[Path] = []
    for suffix in ("-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        if not candidate.exists() and not candidate.is_symlink():
            continue
        validate_database_file(candidate, agent_uid, agent_gid)
        sidecars.append(candidate)
    return sidecars


def open_database(path: Path) -> sqlite3.Connection:
    uri_path = urllib.parse.quote(str(path), safe="/")
    try:
        connection = sqlite3.connect(f"file:{uri_path}?mode=ro", uri=True, timeout=5)
        connection.execute("PRAGMA query_only = ON")
        result = connection.execute("PRAGMA quick_check").fetchall()
    except sqlite3.Error:
        fail("agent database could not be opened read-only")
    if result != [("ok",)]:
        connection.close()
        fail("agent database failed SQLite quick_check")
    return connection


def table_names(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {str(row[0]) for row in rows}


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    if table not in {"vms", *AUXILIARY_SCHEMA}:
        fail("internal cutover schema inspection error")
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        fail(f"cached desired-state {label} has an unknown shape")


def require_nonempty_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        fail(f"cached desired-state tombstone has an invalid {label}")


def require_integer(value: Any, minimum: int, maximum: int, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        fail(f"cached desired-state tombstone has an invalid {label}")


def validate_absent_tombstone(value: Any, database_kind: str) -> None:
    if not isinstance(value, dict):
        fail("cached desired-state VM tombstone is not an object")
    require_exact_keys(
        value,
        {
            "run_id",
            "vm_name",
            "desired_phase",
            "image_key",
            "image_sha256",
            "resources",
            "ssh_authorized_keys_openssh",
            "lease_expires_at_unix_ms",
        },
        "VM tombstone",
    )
    require_nonempty_string(value["run_id"], "run_id")
    require_nonempty_string(value["vm_name"], "vm_name")
    if value["desired_phase"] != "absent":
        fail("cached desired state still contains a non-absent VM workload")

    image_key = value["image_key"]
    if not isinstance(image_key, dict):
        fail("cached desired-state tombstone image_key is not an object")
    require_exact_keys(image_key, {"scenario", "vm", "arch"}, "image_key")
    require_nonempty_string(image_key["scenario"], "image_key.scenario")
    require_nonempty_string(image_key["vm"], "image_key.vm")
    if image_key["arch"] not in ("x86_64", "aarch64"):
        fail("cached desired-state tombstone has an invalid image_key.arch")

    image_sha256 = value["image_sha256"]
    if not isinstance(image_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", image_sha256) is None:
        fail("cached desired-state tombstone has an invalid image_sha256")

    resources = value["resources"]
    if not isinstance(resources, dict):
        fail("cached desired-state tombstone resources is not an object")
    if database_kind == "legacy":
        require_exact_keys(resources, {"cpu_count", "memory_mib", "disk_mib"}, "resources")
        require_integer(resources["cpu_count"], 1, 65_535, "resources.cpu_count")
    elif database_kind == "current":
        require_exact_keys(
            resources,
            {"cpu_millis", "vcpu_count", "memory_mib", "disk_mib"},
            "resources",
        )
        require_integer(resources["cpu_millis"], 1, 4_294_967_295, "resources.cpu_millis")
        require_integer(resources["vcpu_count"], 1, 65_535, "resources.vcpu_count")
        if resources["cpu_millis"] > resources["vcpu_count"] * 1_000:
            fail("cached desired-state tombstone CPU exceeds its vCPU topology")
    else:
        fail("internal cutover database generation error")
    require_integer(resources["memory_mib"], 0, 4_294_967_295, "resources.memory_mib")
    require_integer(resources["disk_mib"], 0, 4_294_967_295, "resources.disk_mib")

    authorized_keys = value["ssh_authorized_keys_openssh"]
    if not isinstance(authorized_keys, list) or not all(
        isinstance(key, str) for key in authorized_keys
    ):
        fail("cached desired-state tombstone has invalid SSH authorized keys")
    require_integer(
        value["lease_expires_at_unix_ms"],
        -(2**63),
        2**63 - 1,
        "lease_expires_at_unix_ms",
    )


def inspect_workload_state(connection: sqlite3.Connection) -> tuple[str, dict[str, int]]:
    tables = table_names(connection)
    missing = set(WORKLOAD_TABLES) - tables
    if missing or not set(AUXILIARY_SCHEMA) <= tables:
        fail("agent database is not a recognized V5 or V6 baseline schema")
    for table, required_columns in AUXILIARY_SCHEMA.items():
        if not required_columns <= table_columns(connection, table):
            fail("agent database is not a recognized V5 or V6 baseline schema")

    columns = table_columns(connection, "vms")
    if V6_VM_COLUMNS <= columns:
        database_kind = "current"
    elif LEGACY_VM_COLUMNS <= columns and not (columns & (V6_VM_COLUMNS - LEGACY_VM_COLUMNS)):
        database_kind = "legacy"
    else:
        fail("agent database has a partially upgraded or unknown VM schema")

    counts: dict[str, int] = {}
    for table in ("vms", "vm_probe_state", "archive_jobs"):
        count = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        counts[table] = count
        if count != 0:
            fail(f"agent database still contains {table} workload state")

    desired_rows = connection.execute("SELECT doc_json FROM desired_state").fetchall()
    counts["desired_state"] = len(desired_rows)
    counts["desired_vm_tombstones"] = 0
    for (document_text,) in desired_rows:
        try:
            document = json.loads(document_text)
        except (TypeError, json.JSONDecodeError):
            fail("cached desired state is not valid JSON")
        if not isinstance(document, dict):
            fail("cached desired state is not a JSON object")
        vms = document.get("vms")
        builds = document.get("builds")
        if not isinstance(vms, list) or not isinstance(builds, list):
            fail("cached desired state has an unknown workload shape")
        if builds:
            fail("cached desired state still contains build workloads")
        for vm in vms:
            validate_absent_tombstone(vm, database_kind)
        counts["desired_vm_tombstones"] += len(vms)

    return database_kind, counts


def inspect_state(
    config_path: Path,
    database_path: Path,
    agent_uid: int,
    agent_gid: int,
) -> tuple[str, bytes | None, dict[str, Any] | None, os.stat_result | None, sqlite3.Connection | None, dict[str, int]]:
    config_exists = config_path.exists() or config_path.is_symlink()
    database_exists = database_path.exists() or database_path.is_symlink()
    if not config_exists and not database_exists:
        return "fresh", None, None, None, None, {}
    if not config_exists:
        fail("agent database exists without an agent config")

    content, parsed, config_metadata = read_config(config_path, agent_gid)
    cfg_kind = config_kind(parsed)
    if not database_exists:
        if cfg_kind == "current":
            return "current", content, parsed, config_metadata, None, {}
        fail("legacy agent config exists without the SQLite state needed to prove a safe cutover")

    database_metadata = validate_database_file(database_path, agent_uid, agent_gid)
    validate_sidecars(database_path, agent_uid, agent_gid)
    connection = open_database(database_path)
    try:
        opened_metadata = os.stat(database_path, follow_symlinks=False)
        if (opened_metadata.st_dev, opened_metadata.st_ino) != (
            database_metadata.st_dev,
            database_metadata.st_ino,
        ):
            fail("agent database changed while it was inspected")
        db_kind, counts = inspect_workload_state(connection)
    except Exception:
        connection.close()
        raise
    if cfg_kind != db_kind:
        connection.close()
        fail("agent config and SQLite schema are from different bridge generations")
    state = "legacy-drained" if cfg_kind == "legacy" else "current"
    return state, content, parsed, config_metadata, connection, counts


def require_archive_directory(path: Path) -> None:
    require_absolute(path, "cutover archive")
    validate_directory(
        path.parent,
        owner_uid=0,
        owner_gid=0,
        private=True,
        label="cutover archive parent",
    )
    try:
        metadata = os.lstat(path)
    except OSError:
        fail("cutover archive directory is missing")
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0:
        fail("cutover archive directory must be a root-owned directory")
    if mode_bits(metadata) & 0o077:
        fail("cutover archive directory must have mode 0700")
    if any(path.iterdir()):
        fail("cutover archive directory must be empty")


def write_private(path: Path, content: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_replacement_config(
    config_path: Path,
    content: bytes,
    metadata: os.stat_result,
) -> Path:
    fd, temporary_name = tempfile.mkstemp(prefix=".config.toml.v6-cutover-", dir=config_path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, mode_bits(metadata))
        os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    return temporary


def apply_cutover(
    config_path: Path,
    database_path: Path,
    archive_dir: Path,
    agent_uid: int,
    agent_gid: int,
) -> None:
    require_archive_directory(archive_dir)
    initial_database = validate_database_file(database_path, agent_uid, agent_gid)
    state, config_content, parsed, config_metadata, connection, counts = inspect_state(
        config_path, database_path, agent_uid, agent_gid
    )
    if state != "legacy-drained" or config_content is None or parsed is None:
        if connection is not None:
            connection.close()
        fail("--apply is valid only for a drained, internally consistent V5 agent state")
    if config_metadata is None or connection is None:
        fail("legacy cutover state is incomplete")

    migrated_content = remove_legacy_binary(config_content, parsed)
    archived_config = archive_dir / "intar-agent.config.v5.toml"
    archived_database = archive_dir / "intar-agent.v5.sqlite3"
    manifest_path = archive_dir / "manifest.json"
    write_private(archived_config, config_content)
    try:
        destination = sqlite3.connect(archived_database)
        try:
            connection.backup(destination)
        finally:
            destination.close()
    except sqlite3.Error:
        connection.close()
        fail("failed to create the consistent SQLite cutover archive")
    connection.close()
    os.chmod(archived_database, 0o600, follow_symlinks=False)
    with archived_database.open("rb") as archived_handle:
        os.fsync(archived_handle.fileno())
    with sqlite3.connect(f"file:{urllib.parse.quote(str(archived_database), safe='/')}?mode=ro", uri=True) as archived:
        if archived.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            fail("archived SQLite database failed quick_check")
        archived_kind, archived_counts = inspect_workload_state(archived)
        if archived_kind != "legacy" or archived_counts != counts:
            fail("agent database changed while the cutover archive was created")

    manifest = {
        "schema_version": 1,
        "cutover": "bridge-v5-to-v6",
        "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source_config_path": str(config_path),
        "source_database_path": str(database_path),
        "config_sha256": hashlib.sha256(config_content).hexdigest(),
        "database_sha256": sha256_file(archived_database),
        "verified_safe_state": counts,
        "removed_config_key": "cloud_hypervisor.binary",
    }
    write_private(manifest_path, (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode())
    fsync_directory(archive_dir)

    replacement = write_replacement_config(config_path, migrated_content, config_metadata)
    try:
        # Revalidate all mutable agent-owned state immediately before commit.
        current_database = validate_database_file(database_path, agent_uid, agent_gid)
        validate_sidecars(database_path, agent_uid, agent_gid)
        if (current_database.st_dev, current_database.st_ino) != (
            initial_database.st_dev,
            initial_database.st_ino,
        ):
            fail("agent database changed before cutover commit")
        final_connection = open_database(database_path)
        try:
            final_kind, final_counts = inspect_workload_state(final_connection)
        finally:
            final_connection.close()
        if final_kind != "legacy" or final_counts != counts:
            fail("agent database changed before cutover commit")

        os.replace(replacement, config_path)
        fsync_directory(config_path.parent)
        for sidecar in validate_sidecars(database_path, agent_uid, agent_gid):
            sidecar.unlink()
        database_path.unlink()
        fsync_directory(database_path.parent)
    finally:
        if replacement.exists():
            replacement.unlink()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect or apply the destructive bridge V6 agent cutover")
    parser.add_argument("--mode", required=True, choices=("inspect", "apply"))
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--agent-uid", required=True, type=int)
    parser.add_argument("--agent-gid", required=True, type=int)
    parser.add_argument("--archive-dir", type=Path)
    return parser.parse_args()


def main() -> int:
    os.umask(0o077)
    args = parse_args()
    if os.geteuid() != 0:
        fail("must run as root")
    if args.agent_uid <= 0 or args.agent_gid <= 0:
        fail("agent UID and GID must be positive")
    if args.mode == "inspect":
        if args.archive_dir is not None:
            fail("--archive-dir is valid only with --mode apply")
        state, _, _, _, connection, _ = inspect_state(
            args.config, args.database, args.agent_uid, args.agent_gid
        )
        if connection is not None:
            connection.close()
        print(state)
        return 0
    if args.archive_dir is None:
        fail("--archive-dir is required with --mode apply")
    apply_cutover(
        args.config,
        args.database,
        args.archive_dir,
        args.agent_uid,
        args.agent_gid,
    )
    print(f"V5 agent config and SQLite state archived at {args.archive_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CutoverError as error:
        print(f"intar V6 cutover: {error}", file=sys.stderr)
        raise SystemExit(1)
