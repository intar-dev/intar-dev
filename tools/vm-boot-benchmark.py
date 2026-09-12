#!/usr/bin/env python3
"""Plan, collect, validate, and report fresh VM boot benchmark evidence.

This program does not create a scenario run, start a VM, change a host, or
clear a filesystem cache.  It writes a deterministic launch schedule and
validates evidence from the browser, the scenario host, and the agent log.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping


SCHEMA_VERSION = 1
IMPLEMENTATIONS = ("baseline", "candidate")
DEFAULT_CONDITIONS = ("serial", "concurrency-4", "cache-refresh")
CONDITIONS: dict[str, dict[str, Any]] = {
    "serial": {
        "launch_concurrency": 1,
        "cache_mode": "prepared-cache",
        "cache_refresh_required": False,
    },
    "concurrency-4": {
        "launch_concurrency": 4,
        "cache_mode": "prepared-cache",
        "cache_refresh_required": False,
    },
    "cache-refresh": {
        "launch_concurrency": 1,
        "cache_mode": "prepared-cache",
        "cache_refresh_required": True,
    },
    "filesystem-cold": {
        "launch_concurrency": 1,
        "cache_mode": "filesystem-cold",
        "cache_refresh_required": False,
    },
}
BOOT_TIMING_VERSION = 2
AGENT_TIMING_KEYS = (
    "queue_ms",
    "image_cache_ms",
    "disk_stage_ms",
    "jail_launch_ms",
    "vmm_start_ms",
    "vm_api_ms",
    "guest_ready_ms",
    "quota_seal_ms",
    "ssh_verify_ms",
    "terminal_publish_ms",
    "total_ms",
    "guest_runtime_disk_ms",
    "guest_tools_disk_ms",
    "guest_network_ms",
    "guest_ssh_keys_ms",
    "guest_ssh_service_ms",
    "guest_kino_ms",
    "guest_ready_uptime_ms",
)
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SAFE_FAILURE_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
FIELD = re.compile(r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>[^\s]+)")
ANSI_SGR = re.compile(r"\x1b\[[0-9;]*m")
PSI_RESOURCES = ("cpu", "io", "memory")
MAX_HTTP_BYTES = 2 * 1024 * 1024


class BenchmarkError(RuntimeError):
    """A controlled error that is safe to print to an operator."""


def fail(message: str) -> None:
    raise BenchmarkError(message)


def now_unix_ms() -> int:
    return time.time_ns() // 1_000_000


def require_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{name} must be a nonempty string")
    return value


def require_id(value: object, name: str) -> str:
    value = require_string(value, name)
    if not SAFE_ID.fullmatch(value):
        fail(f"{name} has an invalid format")
    return value


def require_run_id(value: object, name: str = "run_id") -> str:
    value = require_string(value, name)
    if not SAFE_RUN_ID.fullmatch(value):
        fail(f"{name} has an invalid format")
    return value


def require_sha256(value: object, name: str) -> str:
    value = require_string(value, name)
    if not HEX_SHA256.fullmatch(value):
        fail(f"{name} must be a lowercase SHA-256 digest")
    return value


def require_int(value: object, name: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        fail(f"{name} must be an integer of at least {minimum}")
    return value


def require_object(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def load_json(path: Path, name: str) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        fail(f"{name} is missing: {path}")
        raise AssertionError from error
    except json.JSONDecodeError as error:
        fail(f"{name} is not valid JSON: {path}")
        raise AssertionError from error
    return require_object(raw, name)


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def write_json(path: Path | None, value: object) -> None:
    text = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if path is None:
        sys.stdout.write(text)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temporary:
        temporary.write(text)
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)


def output_path(value: str) -> Path | None:
    return None if value == "-" else Path(value)


def parse_conditions(values: list[str]) -> tuple[str, ...]:
    if not values:
        fail("at least one condition is required")
    result: list[str] = []
    for value in values:
        if value not in CONDITIONS:
            fail(f"unknown condition: {value}")
        if value in result:
            fail(f"condition is duplicated: {value}")
        result.append(value)
    return tuple(result)


def parse_scenarios(values: list[str]) -> tuple[str, ...]:
    if not values:
        fail("at least one scenario is required")
    result: list[str] = []
    for value in values:
        scenario = require_id(value, "scenario")
        if scenario in result:
            fail(f"scenario is duplicated: {scenario}")
        result.append(scenario)
    return tuple(result)


def parse_participants(values: list[str]) -> tuple[str, ...]:
    if not values:
        fail("at least one benchmark participant is required")
    result: list[str] = []
    for value in values:
        participant = require_id(value, "participant")
        if participant in result:
            fail(f"participant is duplicated: {participant}")
        result.append(participant)
    return tuple(result)


def parse_scenario_vm_counts(
    values: list[str], scenarios: tuple[str, ...]
) -> dict[str, int]:
    """Parse immutable scenario topology from the deployed catalog.

    A run can own more than one VM. The public run status deliberately does
    not disclose the runtime VM names, so the benchmark plan records only the
    expected count. Later evidence must contain exactly that many agent and
    cgroup records for the new run.
    """

    counts: dict[str, int] = {}
    for value in values:
        scenario, separator, raw_count = value.partition("=")
        if not separator:
            fail("scenario VM count must use <scenario-id>=<count>")
        scenario_id = require_id(scenario, "scenario VM count scenario ID")
        if scenario_id in counts:
            fail(f"scenario VM count is duplicated: {scenario_id}")
        try:
            count = int(raw_count)
        except ValueError:
            fail(f"scenario VM count for {scenario_id} is not an integer")
        counts[scenario_id] = require_int(count, f"scenario VM count for {scenario_id}", 1)
    if set(counts) != set(scenarios):
        missing = sorted(set(scenarios) - set(counts))
        unknown = sorted(set(counts) - set(scenarios))
        details = []
        if missing:
            details.append("missing " + ", ".join(missing))
        if unknown:
            details.append("unknown " + ", ".join(unknown))
        fail("scenario VM counts must cover each planned scenario (" + "; ".join(details) + ")")
    return counts


def release_record(release_id: str, manifest_sha256: str) -> dict[str, str]:
    return {
        "id": require_id(release_id, "release ID"),
        "manifest_sha256": require_sha256(manifest_sha256, "release manifest SHA-256"),
    }


def planned_sample_id(
    scenario_id: str, condition: str, implementation: str, ordinal: int
) -> str:
    return f"{scenario_id}--{condition}--{implementation}--{ordinal:03d}"


def create_plan(args: argparse.Namespace) -> dict[str, Any]:
    plan_id = require_id(args.plan_id, "plan ID")
    scenarios = parse_scenarios(args.scenario)
    scenario_vm_counts = parse_scenario_vm_counts(args.scenario_vm_count or [], scenarios)
    participants = parse_participants(args.participant)
    conditions = parse_conditions(args.condition or list(DEFAULT_CONDITIONS))
    samples = require_int(args.samples_per_implementation, "samples per implementation", 1)
    block_size = require_int(args.block_size, "block size", 1)
    if samples % block_size != 0:
        fail("samples per implementation must divide exactly into the block size")
    for condition in conditions:
        if block_size % CONDITIONS[condition]["launch_concurrency"]:
            fail(f"block size must divide exactly into {condition} launch concurrency")
        if (
            CONDITIONS[condition]["launch_concurrency"] > 1
            and block_size != CONDITIONS[condition]["launch_concurrency"]
        ):
            fail(f"{condition} requires a block size equal to its launch concurrency")
        if len(participants) < CONDITIONS[condition]["launch_concurrency"]:
            fail(f"{condition} needs at least {CONDITIONS[condition]['launch_concurrency']} distinct participants")

    if "filesystem-cold" in conditions:
        isolation_id = require_id(args.filesystem_cold_isolation_id, "filesystem-cold isolation ID")
    else:
        isolation_id = None

    baseline = release_record(args.baseline_release_id, args.baseline_manifest_sha256)
    candidate = release_record(args.candidate_release_id, args.candidate_manifest_sha256)
    if baseline == candidate:
        fail("baseline and candidate releases must differ")

    schedule: list[dict[str, Any]] = []
    next_group = 1
    blocks_per_implementation = samples // block_size
    for condition in conditions:
        settings = CONDITIONS[condition]
        for block_index in range(blocks_per_implementation):
            for scenario_index, scenario_id in enumerate(scenarios):
                first = (
                    "baseline"
                    if (block_index + scenario_index) % 2 == 0
                    else "candidate"
                )
                implementations = (first, "candidate" if first == "baseline" else "baseline")
                for implementation in implementations:
                    group_id = f"{condition}-{next_group:04d}"
                    next_group += 1
                    release = baseline if implementation == "baseline" else candidate
                    for offset in range(block_size):
                        ordinal = block_index * block_size + offset + 1
                        participant_id = participants[(ordinal - 1) % len(participants)]
                        if settings["launch_concurrency"] > 1:
                            participant_id = participants[offset % settings["launch_concurrency"]]
                        sample_id = planned_sample_id(
                            scenario_id, condition, implementation, ordinal
                        )
                        schedule.append(
                            {
                                "sample_id": sample_id,
                                "scenario_id": scenario_id,
                                "expected_vm_count": scenario_vm_counts[scenario_id],
                                "condition": condition,
                                "implementation": implementation,
                                "release": release,
                                "ordinal": ordinal,
                                "block_index": block_index + 1,
                                "launch_group": group_id,
                                "launch_concurrency": settings["launch_concurrency"],
                                "participant_id": participant_id,
                                "cache_mode": settings["cache_mode"],
                                "cache_refresh_required": settings["cache_refresh_required"],
                            }
                        )

    plan: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan_id,
        "created_unix_ms": now_unix_ms(),
        "primary_metric": "terminal_first_command_ms",
        "percentile_method": "nearest-rank",
        "scenarios": list(scenarios),
        "scenario_vm_counts": scenario_vm_counts,
        "participants": list(participants),
        "conditions": list(conditions),
        "samples_per_implementation": samples,
        "block_size": block_size,
        "releases": {"baseline": baseline, "candidate": candidate},
        "filesystem_cold_isolation_id": isolation_id,
        "schedule": schedule,
    }
    plan["plan_sha256"] = hashlib.sha256(canonical_json(plan)).hexdigest()
    return plan


def load_plan(path: Path) -> dict[str, Any]:
    plan = load_json(path, "plan")
    if plan.get("schema_version") != SCHEMA_VERSION:
        fail("plan has an unsupported schema version")
    require_id(plan.get("plan_id"), "plan ID")
    require_sha256(plan.get("plan_sha256"), "plan SHA-256")
    copy = dict(plan)
    actual = copy.pop("plan_sha256")
    if hashlib.sha256(canonical_json(copy)).hexdigest() != actual:
        fail("plan SHA-256 does not match its contents")
    schedule = plan.get("schedule")
    if not isinstance(schedule, list) or not schedule:
        fail("plan has no schedule")
    scenario_counts_source = require_object(plan.get("scenario_vm_counts"), "plan scenario VM counts")
    planned_scenarios = parse_scenarios(
        list(plan.get("scenarios")) if isinstance(plan.get("scenarios"), list) else []
    )
    scenario_counts = parse_scenario_vm_counts(
        [f"{scenario_id}={count}" for scenario_id, count in scenario_counts_source.items()],
        planned_scenarios,
    )
    seen: set[str] = set()
    for entry in schedule:
        item = require_object(entry, "plan schedule item")
        sample_id = require_id(item.get("sample_id"), "sample ID")
        if sample_id in seen:
            fail(f"plan repeats sample ID: {sample_id}")
        seen.add(sample_id)
        if item.get("implementation") not in IMPLEMENTATIONS:
            fail("plan has an invalid implementation")
        if item.get("condition") not in CONDITIONS:
            fail("plan has an invalid condition")
        expected_vm_count = require_int(item.get("expected_vm_count"), "plan expected VM count", 1)
        if expected_vm_count != require_int(
            scenario_counts.get(item.get("scenario_id")), "plan scenario VM count", 1
        ):
            fail("plan sample VM count does not match scenario topology")
        require_id(item.get("participant_id"), "plan participant ID")
        release = require_object(item.get("release"), "plan release")
        release_record(release.get("id"), release.get("manifest_sha256"))
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in schedule:
        groups.setdefault(require_id(item.get("launch_group"), "plan launch group"), []).append(item)
    for entries in groups.values():
        condition = entries[0]["condition"]
        if any(item["condition"] != condition for item in entries):
            fail("plan launch group mixes conditions")
        required = CONDITIONS[condition]["launch_concurrency"]
        if len(entries) != require_int(plan.get("block_size"), "plan block size", 1):
            fail("plan launch group has the wrong sample count")
        participants = [require_id(item.get("participant_id"), "launch group participant") for item in entries]
        if required > 1 and len(set(participants)) != required:
            fail("plan launch group reuses a participant")
    return plan


def parse_json_lines(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError as error:
        fail(f"observation file is missing: {path}")
        raise AssertionError from error
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as error:
            fail(f"observation line {line_number} is not valid JSON")
            raise AssertionError from error
        records.append(require_object(raw, f"observation line {line_number}"))
    return records


def parse_stat_lines(content: str, name: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in content.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        key, raw = fields
        try:
            value = int(raw)
        except ValueError:
            continue
        if value < 0:
            fail(f"{name} contains a negative counter")
        values[key] = value
    if not values:
        fail(f"{name} has no counters")
    return values


def parse_psi(content: str, name: str) -> dict[str, int | None]:
    values: dict[str, int | None] = {"some_total_us": None, "full_total_us": None}
    for line in content.splitlines():
        fields = line.split()
        if not fields:
            continue
        kind = fields[0]
        if kind not in ("some", "full"):
            continue
        total = next((field[6:] for field in fields[1:] if field.startswith("total=")), None)
        if total is None:
            continue
        try:
            total_us = int(total)
        except ValueError:
            fail(f"{name} has an invalid total counter")
        if total_us < 0:
            fail(f"{name} has a negative total counter")
        values[f"{kind}_total_us"] = total_us
    if values["some_total_us"] is None:
        fail(f"{name} has no some total counter")
    return values


def aggregate_io_stat(content: str) -> dict[str, int]:
    totals: dict[str, int] = {}
    for line in content.splitlines():
        fields = line.split()
        if not fields:
            continue
        for field in fields[1:]:
            if "=" not in field:
                continue
            key, raw = field.split("=", 1)
            try:
                value = int(raw)
            except ValueError:
                fail("io.stat has an invalid counter")
            if value < 0:
                fail("io.stat has a negative counter")
            totals[key] = totals.get(key, 0) + value
    return totals


def resolve_cgroup_path(value: str) -> tuple[Path, str]:
    root = Path("/sys/fs/cgroup").resolve(strict=True)
    supplied = Path(value)
    # jailerd persists a cgroup-v2 control-group name such as
    # `/intar.slice/intar-vms.slice/intar-vm-...service`. That leading slash
    # is not a host filesystem path. Accept a real cgroup filesystem path as
    # well for direct host use.
    candidate = (
        supplied
        if supplied.is_absolute() and str(supplied).startswith(f"{root}/")
        else root / str(supplied).lstrip("/")
    )
    candidate = candidate.resolve(strict=True)
    if candidate == root or root not in candidate.parents:
        fail("VM cgroup must be a child of /sys/fs/cgroup")
    relative = candidate.relative_to(root).as_posix()
    return candidate, relative


def capture_vm_cgroup(vm_cgroup: str) -> dict[str, Any]:
    if sys.platform != "linux":
        fail("host capture requires Linux cgroup v2")
    cgroup_path, relative = resolve_cgroup_path(vm_cgroup)
    cpu = parse_stat_lines(
        (cgroup_path / "cpu.stat").read_text(encoding="utf-8"), "cpu.stat"
    )
    for key in ("usage_usec", "nr_throttled", "throttled_usec"):
        if key not in cpu:
            fail(f"cpu.stat is missing {key}")
    io = aggregate_io_stat((cgroup_path / "io.stat").read_text(encoding="utf-8"))
    return {"cgroup": relative, "cpu": cpu, "io": io}


def capture_run_host_snapshot(vm_cgroups: Mapping[str, str]) -> dict[str, Any]:
    if not vm_cgroups:
        fail("run host capture needs at least one VM cgroup")
    captured = {
        require_id(vm_name, "VM name"): capture_vm_cgroup(cgroup)
        for vm_name, cgroup in sorted(vm_cgroups.items())
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "run-cgroup-snapshot",
        "captured_unix_ms": now_unix_ms(),
        "vm_cgroups": captured,
    }


def capture_host_pressure_snapshot() -> dict[str, Any]:
    if sys.platform != "linux":
        fail("host capture requires Linux cgroup v2")
    root = Path("/sys/fs/cgroup")
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "host-pressure-snapshot",
        "captured_unix_ms": now_unix_ms(),
        "host_pressure_us": {
            resource: parse_psi(
                (root / f"{resource}.pressure").read_text(encoding="utf-8"),
                f"{resource}.pressure",
            )
            for resource in PSI_RESOURCES
        },
    }


def read_agent_vms(agent_url: str) -> list[dict[str, Any]]:
    url = agent_url.rstrip("/") + "/vms"
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            content = response.read(MAX_HTTP_BYTES + 1)
    except urllib.error.URLError as error:
        fail(f"cannot read local agent VM inventory: {error.reason}")
        raise AssertionError from error
    if len(content) > MAX_HTTP_BYTES:
        fail("local agent VM inventory is too large")
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        fail("local agent VM inventory is not valid JSON")
        raise AssertionError from error
    if not isinstance(value, list):
        fail("local agent VM inventory is not a list")
    return [require_object(item, "local agent VM inventory item") for item in value]


def find_vm_cgroups_for_run(run_id: str, agent_url: str) -> dict[str, str]:
    run_id = require_run_id(run_id)
    matches: dict[str, str] = {}
    for vm in read_agent_vms(agent_url):
        details = vm.get("details")
        if not isinstance(details, dict) or details.get("run_id") != run_id:
            continue
        cgroup = details.get("jail_cgroup_path")
        if isinstance(cgroup, str) and cgroup:
            vm_name = require_id(vm.get("name"), "local agent VM name")
            if vm_name in matches:
                fail("local agent VM inventory repeats a VM name")
            matches[vm_name] = cgroup
    if not matches:
        fail("no live VM cgroup is available for the requested run")
    if len(set(matches.values())) != len(matches):
        fail("requested run has duplicate live VM cgroups")
    return matches


def wait_for_vm_cgroups(
    run_id: str, agent_url: str, expected_vm_count: int, wait_seconds: int, poll_ms: int
) -> dict[str, str]:
    wait_seconds = require_int(wait_seconds, "wait seconds")
    expected_vm_count = require_int(expected_vm_count, "expected VM count", 1)
    poll_ms = require_int(poll_ms, "poll milliseconds", 10)
    deadline = time.monotonic() + wait_seconds
    last_error: BenchmarkError | None = None
    while True:
        try:
            cgroups = find_vm_cgroups_for_run(run_id, agent_url)
            if len(cgroups) == expected_vm_count:
                return cgroups
            if len(cgroups) > expected_vm_count:
                fail("live run has more VM cgroups than the planned topology")
            last_error = BenchmarkError(
                f"live run has {len(cgroups)} of {expected_vm_count} planned VM cgroups"
            )
        except BenchmarkError as error:
            last_error = error
        if time.monotonic() >= deadline:
            assert last_error is not None
            raise last_error
        time.sleep(poll_ms / 1_000)


def delta_counter_maps(
    before: Mapping[str, Any], after: Mapping[str, Any], name: str
) -> dict[str, int]:
    result: dict[str, int] = {}
    for key in sorted(set(before) | set(after)):
        old = require_int(before.get(key, 0), f"before {name}.{key}")
        new = require_int(after.get(key, 0), f"after {name}.{key}")
        if new < old:
            fail(f"{name}.{key} decreased between snapshots")
        result[key] = new - old
    return result


def snapshot_vm_cgroups(snapshot: dict[str, Any], name: str) -> dict[str, dict[str, Any]]:
    if snapshot.get("schema_version") != SCHEMA_VERSION:
        fail(f"{name} host snapshot has an unsupported schema version")
    if snapshot.get("kind") != "run-cgroup-snapshot":
        fail(f"{name} host snapshot must be a run-cgroup-snapshot")
    source = require_object(snapshot.get("vm_cgroups"), f"{name} VM cgroups")
    result: dict[str, dict[str, Any]] = {}
    for vm_name, raw in source.items():
        vm = require_id(vm_name, f"{name} VM name")
        if vm in result:
            fail(f"{name} host snapshot repeats VM {vm}")
        cgroup = require_object(raw, f"{name} VM cgroup")
        result[vm] = {
            "cgroup": require_string(cgroup.get("cgroup"), f"{name} VM cgroup path"),
            "cpu": require_object(cgroup.get("cpu"), f"{name} VM CPU counters"),
            "io": require_object(cgroup.get("io"), f"{name} VM I/O counters"),
        }
    if not result:
        fail(f"{name} host snapshot has no VM cgroups")
    return result


def sum_counter_maps(counters: Iterable[Mapping[str, int]]) -> dict[str, int]:
    total: dict[str, int] = {}
    for counters_for_vm in counters:
        for key, value in counters_for_vm.items():
            total[key] = total.get(key, 0) + value
    return total


def host_snapshot_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    if before.get("schema_version") != SCHEMA_VERSION or after.get("schema_version") != SCHEMA_VERSION:
        fail("host snapshot has an unsupported schema version")
    before_time = require_int(before.get("captured_unix_ms"), "before capture time")
    after_time = require_int(after.get("captured_unix_ms"), "after capture time")
    if after_time < before_time:
        fail("host snapshot time moved backwards")
    before_vms = snapshot_vm_cgroups(before, "before")
    after_vms = snapshot_vm_cgroups(after, "after")
    if set(before_vms) != set(after_vms):
        fail("host snapshots do not cover the same VM cgroups")
    cpu_deltas: list[dict[str, int]] = []
    io_deltas: list[dict[str, int]] = []
    final_cpu: list[dict[str, int]] = []
    final_io: list[dict[str, int]] = []
    cgroups: dict[str, str] = {}
    for vm_name in sorted(before_vms):
        old = before_vms[vm_name]
        new = after_vms[vm_name]
        if old["cgroup"] != new["cgroup"]:
            fail(f"VM cgroup changed for {vm_name}")
        cgroups[vm_name] = old["cgroup"]
        cpu_deltas.append(delta_counter_maps(old["cpu"], new["cpu"], f"VM CPU counter {vm_name}"))
        io_deltas.append(delta_counter_maps(old["io"], new["io"], f"VM I/O counter {vm_name}"))
        final_cpu.append({key: require_int(value, f"final VM CPU counter {key}") for key, value in new["cpu"].items()})
        final_io.append({key: require_int(value, f"final VM I/O counter {key}") for key, value in new["io"].items()})
    return {
        "schema_version": SCHEMA_VERSION,
        "vm_count": len(cgroups),
        "vm_cgroups": cgroups,
        "elapsed_ms": after_time - before_time,
        "vm_cgroup_cpu_observed_interval": sum_counter_maps(cpu_deltas),
        "vm_cgroup_io_observed_interval": sum_counter_maps(io_deltas),
        "vm_cgroup_cpu_total_at_command": sum_counter_maps(final_cpu),
        "vm_cgroup_io_total_at_command": sum_counter_maps(final_io),
    }


def host_pressure_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    if before.get("schema_version") != SCHEMA_VERSION or after.get("schema_version") != SCHEMA_VERSION:
        fail("host pressure snapshot has an unsupported schema version")
    if before.get("kind") not in (None, "host-pressure-snapshot") or after.get("kind") not in (
        None,
        "host-pressure-snapshot",
    ):
        fail("host pressure delta needs host-pressure snapshots")
    before_time = require_int(before.get("captured_unix_ms"), "before pressure capture time")
    after_time = require_int(after.get("captured_unix_ms"), "after pressure capture time")
    if after_time < before_time:
        fail("host pressure snapshot time moved backwards")
    before_pressure = require_object(before.get("host_pressure_us"), "before host pressure")
    after_pressure = require_object(after.get("host_pressure_us"), "after host pressure")
    pressure: dict[str, dict[str, int | None]] = {}
    for resource in PSI_RESOURCES:
        before_resource = require_object(before_pressure.get(resource), f"before {resource} pressure")
        after_resource = require_object(after_pressure.get(resource), f"after {resource} pressure")
        pressure[resource] = {}
        for key in ("some_total_us", "full_total_us"):
            old = before_resource.get(key)
            new = after_resource.get(key)
            if old is None and new is None:
                pressure[resource][key] = None
                continue
            old_int = require_int(old, f"before {resource} {key}")
            new_int = require_int(new, f"after {resource} {key}")
            if new_int < old_int:
                fail(f"{resource} {key} decreased between snapshots")
            pressure[resource][key] = new_int - old_int
    return {
        "schema_version": SCHEMA_VERSION,
        "elapsed_ms": after_time - before_time,
        "host_pressure_us": pressure,
    }


def parse_agent_timing_line(line: str) -> dict[str, Any] | None:
    line = ANSI_SGR.sub("", line)
    if "vm booted" not in line:
        return None
    fields = {
        match.group("name"): match.group("value").strip('"')
        for match in FIELD.finditer(line)
    }
    run_id = fields.get("run_id")
    vm = fields.get("vm")
    if run_id is None or vm is None:
        fail("a vm booted event has no run_id or vm field")
    if fields.get("boot_timing_version") != str(BOOT_TIMING_VERSION):
        fail("agent event has an unsupported boot timing version")
    timing: dict[str, int] = {}
    for key in AGENT_TIMING_KEYS:
        raw = fields.get(key)
        if raw is None or not raw.isdigit():
            fail(f"vm booted event for {run_id} has no valid {key}")
        timing[key] = int(raw)
    event = {
        "schema_version": SCHEMA_VERSION,
        "boot_timing_version": BOOT_TIMING_VERSION,
        "run_id": require_run_id(run_id),
        "vm": require_id(vm, "VM name"),
        "phase_ms": timing,
    }
    agent_phase_timings(event)
    return event


def extract_agent_events(input_path: Path, output: Path | None) -> list[dict[str, Any]]:
    try:
        lines = input_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError as error:
        fail(f"agent log input is missing: {input_path}")
        raise AssertionError from error
    events: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for line in lines:
        event = parse_agent_timing_line(line)
        if event is None:
            continue
        identity = (event["run_id"], event["vm"])
        if identity in seen:
            fail(f"agent log repeats vm booted event for {identity[0]}/{identity[1]}")
        seen.add(identity)
        events.append(event)
    if not events:
        fail("agent log has no vm booted events")
    if output is None:
        for event in events:
            sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        text = "".join(json.dumps(event, sort_keys=True) + "\n" for event in events)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output.parent, prefix=f".{output.name}.", delete=False
        ) as temporary:
            temporary.write(text)
            temporary_path = Path(temporary.name)
        temporary_path.replace(output)
    return events


def agent_phase_timings(event: dict[str, Any]) -> dict[str, int]:
    if event.get("boot_timing_version") != BOOT_TIMING_VERSION:
        fail("agent event has an unsupported boot timing version")
    timing = require_object(event.get("phase_ms"), "agent phase timings")
    phases = {key: require_int(timing.get(key), f"agent phase {key}") for key in AGENT_TIMING_KEYS}
    host_keys = AGENT_TIMING_KEYS[:AGENT_TIMING_KEYS.index("total_ms")]
    if sum(phases[key] for key in host_keys) != phases["total_ms"]:
        fail("agent host phases do not sum to total_ms")
    return phases


def load_agent_events(path: Path) -> dict[str, list[dict[str, Any]]]:
    events = parse_json_lines(path)
    result: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        if event.get("schema_version") != SCHEMA_VERSION:
            fail("agent event has an unsupported schema version")
        run_id = require_run_id(event.get("run_id"))
        vm = require_id(event.get("vm"), "agent VM name")
        normalized = {
            "run_id": run_id,
            "vm": vm,
            "boot_timing_version": BOOT_TIMING_VERSION,
            "phase_ms": agent_phase_timings(event),
        }
        events_for_run = result.setdefault(run_id, [])
        if any(item["vm"] == vm for item in events_for_run):
            fail(f"agent event repeats VM {vm} for run {run_id}")
        events_for_run.append(normalized)
    return result


def aggregate_agent_events(run_id: str, events: list[dict[str, Any]], expected_vm_count: int) -> dict[str, Any]:
    if len(events) != expected_vm_count:
        fail("agent event count does not match the planned VM topology")
    by_vm: dict[str, dict[str, Any]] = {}
    for raw_event in events:
        event = require_object(raw_event, "agent VM event")
        if require_run_id(event.get("run_id"), "agent run ID") != run_id:
            fail("agent event run ID does not match the browser run ID")
        vm_name = require_id(event.get("vm"), "agent VM name")
        if vm_name in by_vm:
            fail("agent events repeat a VM")
        by_vm[vm_name] = {
            "run_id": run_id,
            "vm": vm_name,
            "boot_timing_version": BOOT_TIMING_VERSION,
            "phase_ms": agent_phase_timings(event),
        }
    if len(by_vm) != expected_vm_count:
        fail("agent events repeat a VM")
    vms = [by_vm[vm_name] for vm_name in sorted(by_vm)]
    return {
        "run_id": run_id,
        "vm_count": expected_vm_count,
        "vms": vms,
    }


def slowest_agent_phase(agent: Mapping[str, Any], key: str) -> int:
    vms = agent.get("vms")
    if not isinstance(vms, list) or not vms:
        fail("agent evidence has no VM events")
    return max(
        require_int(
            require_object(require_object(vm, "agent VM event").get("phase_ms"), "agent phase timings").get(key),
            key,
        )
        for vm in vms
    )


def normalize_browser_evidence(
    source: dict[str, Any], expected_run_id: str, expected_scenario_id: str
) -> dict[str, Any]:
    run_id = require_run_id(source.get("runId"), "browser runId")
    if run_id != expected_run_id:
        fail("browser evidence runId does not match the requested run")
    scenario_id = require_id(source.get("scenarioId"), "browser scenarioId")
    if scenario_id != expected_scenario_id:
        fail("browser evidence scenarioId does not match the planned sample")
    start = require_int(source.get("startUnixMs"), "browser startUnixMs")
    connected = require_int(source.get("terminalConnectedUnixMs"), "browser terminalConnectedUnixMs")
    first_command = require_object(source.get("firstCommand"), "browser firstCommand")
    command_started = require_int(first_command.get("startedUnixMs"), "first command startedUnixMs")
    command_success = require_int(first_command.get("successUnixMs"), "first command successUnixMs")
    output_observed = first_command.get("outputObservedAfterCommand")
    nonce_sha256_value = first_command.get("nonceSha256")
    if not (start <= connected <= command_started <= command_success):
        fail("browser evidence timestamps are not in boot order")
    if output_observed is not True:
        fail("browser evidence does not prove output after the command was sent")
    nonce_sha256 = require_sha256(nonce_sha256_value, "first command nonce SHA-256")
    stages_value = source.get("stages", {})
    stages = require_object(stages_value, "browser stages")
    normalized_stages = {
        require_id(key, "browser stage name"): require_int(value, f"browser stage {key}")
        for key, value in stages.items()
    }
    if normalized_stages.get("start-click") != start:
        fail("browser evidence start-click mark does not match startUnixMs")
    if normalized_stages.get("terminal-connected") != connected:
        fail("browser evidence terminal-connected mark does not match terminalConnectedUnixMs")
    return {
        "runId": run_id,
        "scenarioId": scenario_id,
        "startUnixMs": start,
        "terminalConnectedUnixMs": connected,
        "firstCommand": {
            "startedUnixMs": command_started,
            "successUnixMs": command_success,
            "nonceSha256": nonce_sha256,
            "outputObservedAfterCommand": True,
        },
        "stages": normalized_stages,
    }


def validate_browser_runner_metadata(
    source: dict[str, Any], expected: dict[str, Any], participant_id: str
) -> None:
    if source.get("schemaVersion") != SCHEMA_VERSION:
        fail("browser evidence has an unsupported schema version")
    if source.get("benchmarkRunId") != expected["sample_id"]:
        fail("browser evidence benchmark run ID does not match the planned sample")
    if source.get("participantId") != participant_id:
        fail("browser evidence participant ID does not match the planned sample")
    if source.get("variant") != expected["implementation"]:
        fail("browser evidence variant does not match the planned sample")
    if source.get("releaseId") != expected["release"]["id"]:
        fail("browser evidence release ID does not match the planned sample")
    if source.get("releaseManifestSha256") != expected["release"]["manifest_sha256"]:
        fail("browser evidence release manifest does not match the planned sample")
    if source.get("startBoundary") != "learner-start-link-click":
        fail("browser evidence did not use the learner Start link")


def normalize_host_delta(source: dict[str, Any]) -> dict[str, Any]:
    if source.get("schema_version") != SCHEMA_VERSION:
        fail("host delta has an unsupported schema version")
    vm_count = require_int(source.get("vm_count"), "host delta VM count", 1)
    cgroups_source = require_object(source.get("vm_cgroups"), "host delta VM cgroups")
    cgroups = {
        require_id(vm_name, "host delta VM name"): require_string(cgroup, "host delta VM cgroup")
        for vm_name, cgroup in cgroups_source.items()
    }
    if len(cgroups) != vm_count:
        fail("host delta VM count does not match its cgroups")
    elapsed = require_int(source.get("elapsed_ms"), "host delta elapsed_ms")
    pressure_source = require_object(source.get("host_pressure_us"), "host pressure delta")
    pressure: dict[str, dict[str, int | None]] = {}
    for resource in PSI_RESOURCES:
        item = require_object(pressure_source.get(resource), f"host {resource} pressure delta")
        pressure[resource] = {}
        for key in ("some_total_us", "full_total_us"):
            value = item.get(key)
            pressure[resource][key] = None if value is None else require_int(value, f"{resource} {key}")
    counter_sources = {
        name: {
            key: require_int(value, f"{name} {key}")
            for key, value in require_object(source.get(name), name).items()
        }
        for name in (
            "vm_cgroup_cpu_observed_interval",
            "vm_cgroup_io_observed_interval",
            "vm_cgroup_cpu_total_at_command",
            "vm_cgroup_io_total_at_command",
        )
    }
    for key in ("usage_usec", "nr_throttled", "throttled_usec"):
        require_int(
            counter_sources["vm_cgroup_cpu_observed_interval"].get(key),
            f"VM cgroup CPU interval {key}",
        )
        require_int(
            counter_sources["vm_cgroup_cpu_total_at_command"].get(key),
            f"VM cgroup CPU total {key}",
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "vm_count": vm_count,
        "vm_cgroups": cgroups,
        "elapsed_ms": elapsed,
        "host_pressure_elapsed_ms": require_int(
            source.get("host_pressure_elapsed_ms"), "host pressure elapsed_ms"
        ),
        "host_pressure_us": pressure,
        **counter_sources,
    }


def schedule_index(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["sample_id"]: item for item in plan["schedule"]}


def append_json_line(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as target:
        target.write(json.dumps(value, sort_keys=True) + "\n")
        target.flush()
        os.fsync(target.fileno())


def record_sample(args: argparse.Namespace) -> dict[str, Any]:
    plan = load_plan(Path(args.plan))
    expected = schedule_index(plan).get(require_id(args.sample_id, "sample ID"))
    if expected is None:
        fail("sample ID is not in the plan")
    participant_id = require_id(args.participant_id, "participant ID")
    if participant_id != expected["participant_id"]:
        fail("participant ID does not match the planned sample")
    output = Path(args.output)
    existing = parse_json_lines(output) if output.exists() else []
    if any(item.get("sample_id") == expected["sample_id"] for item in existing):
        fail("sample already has an observation")

    status = args.status
    if status not in ("success", "failure"):
        fail("status must be success or failure")
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan["plan_id"],
        "plan_sha256": plan["plan_sha256"],
        "sample_id": expected["sample_id"],
        "scenario_id": expected["scenario_id"],
        "condition": expected["condition"],
        "implementation": expected["implementation"],
        "participant_id": participant_id,
        "release": expected["release"],
        "cache_mode": expected["cache_mode"],
        "recorded_unix_ms": now_unix_ms(),
        "status": status,
    }
    if expected["cache_refresh_required"]:
        record["cache_refresh_id"] = require_id(args.cache_refresh_id, "cache refresh ID")
    elif args.cache_refresh_id is not None:
        fail("cache refresh ID is only valid for cache-refresh samples")

    if status == "failure":
        if args.failure_code is None:
            fail("failure samples need a failure code")
        if not SAFE_FAILURE_CODE.fullmatch(args.failure_code):
            fail("failure code has an invalid format")
        record["failure_code"] = args.failure_code
    else:
        if not args.run_id or not args.browser_evidence or not args.agent_events or not args.host_delta:
            fail("success samples need run ID, browser evidence, agent events, and host delta")
        run_id = require_run_id(args.run_id)
        browser_source = load_json(Path(args.browser_evidence), "browser evidence")
        validate_browser_runner_metadata(browser_source, expected, participant_id)
        browser = normalize_browser_evidence(browser_source, run_id, expected["scenario_id"])
        agent_events = load_agent_events(Path(args.agent_events)).get(run_id)
        if agent_events is None:
            fail("agent event is missing for the successful run")
        host = normalize_host_delta(load_json(Path(args.host_delta), "host delta"))
        agent = aggregate_agent_events(run_id, agent_events, expected["expected_vm_count"])
        if host["vm_count"] != expected["expected_vm_count"]:
            fail("host cgroup count does not match the planned VM topology")
        if set(host["vm_cgroups"]) != {event["vm"] for event in agent["vms"]}:
            fail("agent events and host cgroups do not cover the same VMs")
        record["runtime_run_id"] = run_id
        record["browser"] = browser
        record["agent"] = agent
        record["host_delta"] = host
    append_json_line(output, record)
    return record


def validate_observation(
    observation: dict[str, Any], plan: dict[str, Any], expected: dict[str, Any]
) -> dict[str, Any]:
    if observation.get("schema_version") != SCHEMA_VERSION:
        fail(f"{expected['sample_id']}: unsupported observation schema")
    if observation.get("plan_id") != plan["plan_id"] or observation.get("plan_sha256") != plan["plan_sha256"]:
        fail(f"{expected['sample_id']}: observation is from a different plan")
    for key in ("sample_id", "scenario_id", "condition", "implementation", "participant_id", "cache_mode"):
        if observation.get(key) != expected[key]:
            fail(f"{expected['sample_id']}: observation {key} does not match the plan")
    if observation.get("release") != expected["release"]:
        fail(f"{expected['sample_id']}: observation release does not match the plan")
    if expected["cache_refresh_required"]:
        require_id(observation.get("cache_refresh_id"), "cache refresh ID")
    elif "cache_refresh_id" in observation:
        fail(f"{expected['sample_id']}: non-refresh sample has a cache refresh ID")
    status = observation.get("status")
    if status == "failure":
        code = observation.get("failure_code")
        if not isinstance(code, str) or not SAFE_FAILURE_CODE.fullmatch(code):
            fail(f"{expected['sample_id']}: failure has an invalid failure code")
        return observation
    if status != "success":
        fail(f"{expected['sample_id']}: observation has an invalid status")
    run_id = require_run_id(observation.get("runtime_run_id"), "runtime run ID")
    browser = normalize_browser_evidence(
        require_object(observation.get("browser"), "browser evidence"), run_id, expected["scenario_id"]
    )
    agent_source = require_object(observation.get("agent"), "agent evidence")
    if require_run_id(agent_source.get("run_id"), "agent run ID") != run_id:
        fail(f"{expected['sample_id']}: agent run ID does not match browser run ID")
    vms_source = agent_source.get("vms")
    if not isinstance(vms_source, list):
        fail(f"{expected['sample_id']}: agent evidence has no VM events")
    agent = aggregate_agent_events(run_id, vms_source, expected["expected_vm_count"])
    host = normalize_host_delta(require_object(observation.get("host_delta"), "host delta"))
    if host["vm_count"] != expected["expected_vm_count"]:
        fail(f"{expected['sample_id']}: host cgroup count does not match the plan")
    if set(host["vm_cgroups"]) != {event["vm"] for event in agent["vms"]}:
        fail(f"{expected['sample_id']}: agent events and host cgroups cover different VMs")
    normalized = dict(observation)
    normalized["browser"] = browser
    normalized["agent"] = agent
    normalized["host_delta"] = host
    return normalized


def nearest_rank(values: Iterable[int | float], percentile: float) -> int | float | None:
    ordered = sorted(values)
    if not ordered:
        return None
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def summary(values: Iterable[int | float]) -> dict[str, Any]:
    items = list(values)
    if not items:
        return {"count": 0, "median": None, "p95": None, "min": None, "max": None}
    return {
        "count": len(items),
        "median": statistics.median(items),
        "p95": nearest_rank(items, 0.95),
        "min": min(items),
        "max": max(items),
    }


def group_key(item: Mapping[str, Any]) -> tuple[str, str, str]:
    return (str(item["scenario_id"]), str(item["condition"]), str(item["implementation"]))


def metric_values(records: list[dict[str, Any]], key: str) -> list[int]:
    values: list[int] = []
    for record in records:
        browser = record["browser"]
        if key == "terminal_first_command_ms":
            values.append(
                browser["firstCommand"]["successUnixMs"] - browser["startUnixMs"]
            )
        elif key == "terminal_connected_ms":
            values.append(browser["terminalConnectedUnixMs"] - browser["startUnixMs"])
        else:
            values.append(slowest_agent_phase(record["agent"], key))
    return values


def host_metric_values(records: list[dict[str, Any]]) -> dict[str, list[int]]:
    values: dict[str, list[int]] = {}
    for record in records:
        host = record["host_delta"]
        values.setdefault("elapsed_ms", []).append(host["elapsed_ms"])
        if "host_pressure_elapsed_ms" in host:
            values.setdefault("host_pressure_elapsed_ms", []).append(
                host["host_pressure_elapsed_ms"]
            )
        for resource, counters in host["host_pressure_us"].items():
            for key, value in counters.items():
                if value is not None:
                    values.setdefault(f"host_{resource}_{key}", []).append(value)
        for name in (
            "vm_cgroup_cpu_observed_interval",
            "vm_cgroup_io_observed_interval",
            "vm_cgroup_cpu_total_at_command",
            "vm_cgroup_io_total_at_command",
        ):
            for key, value in host[name].items():
                values.setdefault(f"{name}_{key}", []).append(value)
    return values


def report_group(expected: list[dict[str, Any]], observed: list[dict[str, Any]]) -> dict[str, Any]:
    successes = [item for item in observed if item["status"] == "success"]
    failures = [item for item in observed if item["status"] == "failure"]
    failure_codes: dict[str, int] = {}
    for failure in failures:
        code = failure["failure_code"]
        failure_codes[code] = failure_codes.get(code, 0) + 1
    metrics = {
        "terminal_first_command_ms": summary(metric_values(successes, "terminal_first_command_ms")),
        "terminal_connected_ms": summary(metric_values(successes, "terminal_connected_ms")),
        # Agent `total_ms` ends when it publishes terminal-ready state. For a
        # multi-VM run this reports the slowest VM, separate from the browser
        # connection and first command round trip.
        "slowest_vm_terminal_ready_ms": summary(metric_values(successes, "total_ms")),
        **{
            f"slowest_vm_{key}": summary(metric_values(successes, key))
            for key in AGENT_TIMING_KEYS
            if key != "total_ms"
        },
    }
    return {
        "expected_count": len(expected),
        "observed_count": len(observed),
        "success_count": len(successes),
        "failure_count": len(failures),
        "failure_rate": len(failures) / len(observed) if observed else None,
        "failure_codes": dict(sorted(failure_codes.items())),
        "metrics_ms": metrics,
        "host_counter_deltas": {
            key: summary(values) for key, values in sorted(host_metric_values(successes).items())
        },
    }


def report_comparisons(groups: dict[tuple[str, str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    comparisons: list[dict[str, Any]] = []
    pairs = sorted({(scenario, condition) for scenario, condition, _ in groups})
    for scenario_id, condition in pairs:
        baseline = groups[(scenario_id, condition, "baseline")]
        candidate = groups[(scenario_id, condition, "candidate")]
        baseline_metric = baseline["metrics_ms"]["terminal_first_command_ms"]
        candidate_metric = candidate["metrics_ms"]["terminal_first_command_ms"]
        baseline_p50 = baseline_metric["median"]
        candidate_p50 = candidate_metric["median"]
        baseline_p95 = baseline_metric["p95"]
        candidate_p95 = candidate_metric["p95"]
        comparisons.append(
            {
                "scenario_id": scenario_id,
                "condition": condition,
                "primary_metric": "terminal_first_command_ms",
                "candidate_minus_baseline": {
                    "median_ms": None
                    if baseline_p50 is None or candidate_p50 is None
                    else candidate_p50 - baseline_p50,
                    "p95_ms": None
                    if baseline_p95 is None or candidate_p95 is None
                    else candidate_p95 - baseline_p95,
                    "failure_count": candidate["failure_count"] - baseline["failure_count"],
                },
            }
        )
    return comparisons


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    plan = load_plan(Path(args.plan))
    expected_index = schedule_index(plan)
    raw_observations = parse_json_lines(Path(args.observations))
    actual: dict[str, dict[str, Any]] = {}
    for raw in raw_observations:
        sample_id = require_id(raw.get("sample_id"), "observation sample ID")
        expected = expected_index.get(sample_id)
        if expected is None:
            fail(f"observation is not in the plan: {sample_id}")
        if sample_id in actual:
            fail(f"observation repeats sample: {sample_id}")
        actual[sample_id] = validate_observation(raw, plan, expected)
    missing = sorted(set(expected_index) - set(actual))
    if missing and not args.allow_incomplete:
        fail(f"benchmark is incomplete: {len(missing)} planned samples are missing")

    expected_groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    actual_groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for expected in expected_index.values():
        expected_groups.setdefault(group_key(expected), []).append(expected)
    for observation in actual.values():
        actual_groups.setdefault(group_key(observation), []).append(observation)
    groups = {
        key: report_group(expected, actual_groups.get(key, []))
        for key, expected in sorted(expected_groups.items())
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan["plan_id"],
        "plan_sha256": plan["plan_sha256"],
        "generated_unix_ms": now_unix_ms(),
        "complete": not missing,
        "missing_sample_count": len(missing),
        "missing_sample_ids": missing,
        "primary_metric": plan["primary_metric"],
        "percentile_method": plan["percentile_method"],
        "groups": [
            {
                "scenario_id": key[0],
                "condition": key[1],
                "implementation": key[2],
                **value,
            }
            for key, value in groups.items()
        ],
        "comparisons": report_comparisons(groups),
        "notes": [
            "Conditions are reported independently and are never pooled.",
            "Failed boots are counted but excluded from duration percentiles.",
            "No result is a release decision without complete samples and a separate review of failures and host counters.",
        ],
    }


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    plan = subcommands.add_parser("plan", help="write a deterministic benchmark schedule")
    plan.add_argument("--output", required=True)
    plan.add_argument("--plan-id", required=True)
    plan.add_argument("--scenario", action="append", required=True)
    plan.add_argument("--scenario-vm-count", action="append", required=True)
    plan.add_argument("--participant", action="append", required=True)
    plan.add_argument("--baseline-release-id", required=True)
    plan.add_argument("--baseline-manifest-sha256", required=True)
    plan.add_argument("--candidate-release-id", required=True)
    plan.add_argument("--candidate-manifest-sha256", required=True)
    plan.add_argument("--condition", action="append", choices=tuple(CONDITIONS))
    plan.add_argument("--samples-per-implementation", type=int, default=100)
    plan.add_argument("--block-size", type=int, default=4)
    plan.add_argument("--filesystem-cold-isolation-id")

    capture_pressure = subcommands.add_parser(
        "capture-host-pressure", help="read host PSI before or after a VM boot"
    )
    capture_pressure.add_argument("--output", required=True, help="path or - for stdout")

    capture_run = subcommands.add_parser(
        "capture-run-host", help="find a run cgroup through the local agent and read it"
    )
    capture_run.add_argument("--run-id", required=True)
    capture_run.add_argument("--agent-url", default="http://127.0.0.1:8080")
    capture_run.add_argument("--expected-vm-count", type=int, required=True)
    capture_run.add_argument("--wait-seconds", type=int, default=0)
    capture_run.add_argument("--poll-ms", type=int, default=100)
    capture_run.add_argument("--output", required=True, help="path or - for stdout")

    delta = subcommands.add_parser("host-delta", help="calculate a host counter delta")
    delta.add_argument("--before", required=True)
    delta.add_argument("--after", required=True)
    delta.add_argument("--host-pressure-before", required=True)
    delta.add_argument("--host-pressure-after", required=True)
    delta.add_argument("--output", required=True, help="path or - for stdout")

    extract = subcommands.add_parser(
        "extract-agent-events", help="extract safe timing records from exported agent logs"
    )
    extract.add_argument("--input", required=True)
    extract.add_argument("--output", required=True, help="path or - for stdout")

    record = subcommands.add_parser("record", help="validate and append one sample observation")
    record.add_argument("--plan", required=True)
    record.add_argument("--sample-id", required=True)
    record.add_argument("--participant-id", required=True)
    record.add_argument("--output", required=True)
    record.add_argument("--status", required=True, choices=("success", "failure"))
    record.add_argument("--run-id")
    record.add_argument("--browser-evidence")
    record.add_argument("--agent-events")
    record.add_argument("--host-delta")
    record.add_argument("--cache-refresh-id")
    record.add_argument("--failure-code")

    report = subcommands.add_parser("report", help="validate samples and write a grouped JSON report")
    report.add_argument("--plan", required=True)
    report.add_argument("--observations", required=True)
    report.add_argument("--output", required=True, help="path or - for stdout")
    report.add_argument("--allow-incomplete", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        if args.command == "plan":
            write_json(Path(args.output), create_plan(args))
        elif args.command == "capture-host-pressure":
            write_json(output_path(args.output), capture_host_pressure_snapshot())
        elif args.command == "capture-run-host":
            cgroups = wait_for_vm_cgroups(
                args.run_id,
                args.agent_url,
                args.expected_vm_count,
                args.wait_seconds,
                args.poll_ms,
            )
            write_json(output_path(args.output), capture_run_host_snapshot(cgroups))
        elif args.command == "host-delta":
            value = host_snapshot_delta(
                load_json(Path(args.before), "before host snapshot"),
                load_json(Path(args.after), "after host snapshot"),
            )
            pressure = host_pressure_delta(
                load_json(Path(args.host_pressure_before), "before host pressure snapshot"),
                load_json(Path(args.host_pressure_after), "after host pressure snapshot"),
            )
            value["host_pressure_us"] = pressure["host_pressure_us"]
            value["host_pressure_elapsed_ms"] = pressure["elapsed_ms"]
            write_json(output_path(args.output), value)
        elif args.command == "extract-agent-events":
            extract_agent_events(Path(args.input), output_path(args.output))
        elif args.command == "record":
            record_sample(args)
        elif args.command == "report":
            write_json(output_path(args.output), build_report(args))
        else:  # pragma: no cover - argparse prevents this branch.
            fail("unknown command")
    except BenchmarkError as error:
        print(f"vm-boot-benchmark: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
