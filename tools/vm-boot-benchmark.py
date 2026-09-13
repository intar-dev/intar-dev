#!/usr/bin/env python3
"""Plan, collect, validate, and report fresh VM boot benchmark evidence.

This program does not create a scenario run, start a VM, change a host, or
clear a filesystem cache.  It writes a deterministic launch schedule and
validates evidence from the browser, the scenario host, and the agent log.

Schema version 2 has no compatibility path: a plan or observation from an
older schema is rejected.  A sample is ready only after the host security seal
and recorded PTY output.  A connected WebSocket is not readiness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping


SCHEMA_VERSION = 2
RUN_MANIFEST_KIND = "vm-boot-benchmark-run-manifest"
RELEASE_EVIDENCE_KIND = "intar-release-bundle-evidence"
DRY_RUN_KIND = "vm-boot-benchmark-dry-run"
RELEASE_COMPONENTS = ("web", "agent", "jailerd", "gateway", "kernel", "initrd", "images")
KINO_ABI = 2
IMPLEMENTATIONS = ("baseline", "candidate")
P50_TARGET_MS = 2000
P95_TARGET_MS = 4000
SAMPLES_PER_IMPLEMENTATION = 100
BLOCK_SIZE = 4
REQUIRED_SCENARIO_COUNT = 3
CONCURRENT_PARTICIPANTS = 4
CLIENT_REGION = "eu"
MAX_RTT_TOLERANCE_MS = 50
HOST_SECURITY_PHASE = "quota_seal_ms"
# A candidate must record the moment the terminal became visible in the
# learner page. The baseline is the old release and does not carry it.
TERMINAL_VISIBLE_STAGE = "terminal-visible"
DEFAULT_CONDITIONS = (
    "serial-prepared",
    "concurrent-4-prepared",
    "serial-background-cache",
    "concurrent-4-background-cache-archive",
)
CONDITIONS: dict[str, dict[str, Any]] = {
    "serial-prepared": {
        "launch_concurrency": 1,
        "cache_mode": "prepared-cache",
        "background_workload": None,
    },
    "concurrent-4-prepared": {
        "launch_concurrency": 4,
        "cache_mode": "prepared-cache",
        "background_workload": None,
    },
    "serial-background-cache": {
        "launch_concurrency": 1,
        "cache_mode": "prepared-cache",
        "background_workload": "cache-refresh",
    },
    "concurrent-4-background-cache-archive": {
        "launch_concurrency": 4,
        "cache_mode": "prepared-cache",
        "background_workload": "cache-refresh+archive",
    },
}
BACKGROUND_WORKLOAD_KEYS = ("cache-refresh", "cache-refresh+archive")
FOREGROUND_WORKLOAD_KEYS = frozenset({"workload_id", "controller", "controller_lease_id"})
BACKGROUND_WORKLOAD_FIELDS = frozenset({"workload_id", "rate_per_min", "window"})
BACKGROUND_WINDOW_KEYS = frozenset({"start_unix_ms", "end_unix_ms"})
HOST_KEYS = frozenset(
    {
        "controller",
        "controller_lease_id",
        "isolation_id",
        "cpu_class",
        "region",
        "role",
        "production",
        "serves_learners",
        "hardware_class",
        "attestation_file",
    }
)
HOST_ATTESTATION_KIND = "vm-boot-benchmark-host-attestation"
HOST_ATTESTATION_KEYS = frozenset(
    {
        "schema_version",
        "kind",
        "verified",
        "environment",
        "hostname",
        "hardware",
        "cpu_cores",
        "memory_mib",
        "active_vms",
        "controller",
        "controller_lease_id",
        "isolation_id",
        "role",
        "serves_learners",
        "hardware_class",
        "production",
        "cpu_class",
        "region",
        "captured_unix_ms",
        "basis",
    }
)
WORKLOAD_EVENTS_KIND = "vm-boot-benchmark-workload-events"
WORKLOAD_EVENTS_KEYS = frozenset(
    {"schema_version", "kind", "host", "captured_unix_ms", "events"}
)
WORKLOAD_EVENT_KEYS = frozenset({"unix_ms", "workload", "kind", "job", "source", "message"})
WORKLOAD_EVENT_KINDS = ("start", "end")
# Which observed agent workload labels count as proof for a declared key. The
# agent that this benchmark measures logs its refresh pass and its incremental
# scrub; nothing logs an archive step, so the archive half is an honest limit
# and not a claim.
OBSERVABLE_WORKLOADS = {
    "cache-refresh": ("cache-refresh",),
    "cache-refresh+archive": ("cache-refresh", "archive"),
}
TEARDOWN_STATES = ("destroyed", "failed", "not-needed")
# A smoke plan is a functional and plausibility check on the real path. It never
# produces an acceptance result, however many samples it holds.
PLAN_ROLES = ("smoke", "full")
HOST_ROLES = ("isolated-benchmark", "drained-production", "ci-runner")
COMPARABILITY_KEYS = frozenset(
    {"reference_class", "measured_class", "matches_reference", "reason"}
)
# What the numbers from each host role can support. The role is a declaration,
# not a safety gate: the safety gates are the verified attestation, the drained
# host, and the per-sample proof.
CLAIM_CEILINGS = {
    "isolated-benchmark": (
        "release-grade comparison, when the measured class matches the reference class"
    ),
    "drained-production": (
        "authorized maintenance-window measurement on the production host itself:"
        " baseline and candidate on the same server, drained, with the same client"
        " and the same release manifest shape; host load and pressure stay in the review"
    ),
    "ci-runner": (
        "functional proof and agent phase timings; the runner class is not the"
        " production class, so the numbers are not a learner latency comparison"
    ),
}
MEASUREMENT_LIMITS = (
    "The declared background workload rate is an operator input; the tool proves that the"
    " workload was active across each sample window, not the rate.",
    "Background work parks between blocks while a VM boot is critical, so a window can contain"
    " no workload event of its own. An interval that started before the window and is still"
    " open, or that ends after the window, is accepted and recorded.",
    "The client round trip time is measured at the browser and recorded per sample.",
    "The host attestation proves what the host reported and what the run manifest declared;"
    " the tool cannot detect a host that lies.",
)
CLIENT_KEYS = frozenset({"region", "observed_rtt_ms"})
CLIENT_RTT_RANGE_KEYS = frozenset({"min_ms", "max_ms"})
LEGACY_KINO_ABI = 1
SCENARIO_KEYS = frozenset({"id", "vm_count"})
RELEASE_REFERENCE_KEYS = frozenset({"id", "evidence_file"})
RUN_MANIFEST_KEYS = frozenset(
    {
        "schema_version",
        "kind",
        "run_id",
        "foreground_workload",
        "host",
        "comparability",
        "client",
        "participants",
        "scenarios",
        "releases",
        "background_workloads",
        "randomization",
    }
)
RELEASE_EVIDENCE_KEYS = frozenset(
    {
        "schema_version",
        "kind",
        "release_id",
        "measured_unix_ms",
        "network_actions",
        "bundle_digest_sha256",
        "components",
    }
)
RELEASE_COMPONENT_KEYS = frozenset({"id", "file", "sha256", "size_bytes", "kino_abi"})
RELEASE_BUNDLE_MANIFEST_KEYS = frozenset({"schema_version", "kind", "release_id", "components"})
RELEASE_BUNDLE_COMPONENT_KEYS = frozenset({"id", "file", "kino_abi"})
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


def require_keys(value: Mapping[str, Any], allowed: frozenset[str], name: str) -> None:
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        fail(f"{name} has unsupported fields: " + ", ".join(unknown))


def require_kino_abi(value: object, name: str) -> int:
    """Accept the current image ABI and the ABI of an already deployed release.

    The benchmark measures the artifact that is deployed. A baseline bundle
    may still carry the older ABI, and the run manifest decides which release
    may. This is measurement of an old artifact, not a runtime compatibility
    path: the runtime keeps no dual support.
    """

    abi = require_int(value, f"{name} Kino ABI", 1)
    if abi not in (LEGACY_KINO_ABI, KINO_ABI):
        fail(f"{name} must pin Kino ABI {LEGACY_KINO_ABI} or {KINO_ABI}, got {abi}")
    return abi


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


def sha256_file(path: Path, name: str) -> str:
    try:
        content = path.read_bytes()
    except FileNotFoundError as error:
        fail(f"{name} is missing: {path}")
        raise AssertionError from error
    return hashlib.sha256(content).hexdigest()


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


def resolve_relative_file(base: Path, relative: object, name: str) -> Path:
    """Resolve a path that must stay inside the run manifest directory."""

    text = require_string(relative, name)
    if text.startswith("/") or ".." in Path(text).parts:
        fail(f"{name} must be a relative path inside the run manifest directory")
    return (base / text).resolve()


def load_release_evidence(path: Path, expected_release_id: str) -> dict[str, Any]:
    """Read release bundle evidence that a real bundle inspection produced.

    This tool never compares a declared digest with itself.  It records the
    digest that the read-only bundle helper measured on the downloaded
    artifacts, and it keeps the evidence file digest so a plan can be tied to
    one measured bundle.
    """

    evidence = load_json(path, "release bundle evidence")
    if evidence.get("schema_version") != SCHEMA_VERSION:
        fail("release bundle evidence has an unsupported schema version")
    if evidence.get("kind") != RELEASE_EVIDENCE_KIND:
        fail(f"release bundle evidence must have kind {RELEASE_EVIDENCE_KIND}")
    require_keys(evidence, RELEASE_EVIDENCE_KEYS, "release bundle evidence")
    release_id = require_id(evidence.get("release_id"), "release bundle evidence release ID")
    if release_id != expected_release_id:
        fail("release bundle evidence release ID does not match the run manifest")
    require_sha256(evidence.get("bundle_digest_sha256"), "release bundle digest")
    components_source = require_object(evidence.get("components"), "release bundle components")
    if set(components_source) != set(RELEASE_COMPONENTS):
        fail(
            "release bundle evidence must cover exactly "
            + ", ".join(RELEASE_COMPONENTS)
        )
    components: dict[str, dict[str, Any]] = {}
    for component in RELEASE_COMPONENTS:
        item = require_object(components_source[component], f"release bundle component {component}")
        require_keys(item, RELEASE_COMPONENT_KEYS, f"release bundle component {component}")
        record: dict[str, Any] = {
            "id": require_id(item.get("id"), f"release bundle component {component} ID"),
            "sha256": require_sha256(
                item.get("sha256"), f"release bundle component {component} SHA-256"
            ),
            "size_bytes": require_int(
                item.get("size_bytes"), f"release bundle component {component} size", 1
            ),
        }
        if component == "images":
            record["kino_abi"] = require_kino_abi(item.get("kino_abi"), "release bundle images")
        components[component] = record
    return {
        "id": release_id,
        "evidence_sha256": sha256_file(path, "release bundle evidence"),
        "images_kino_abi": components["images"]["kino_abi"],
        "components": components,
    }


def validate_release_bundle(args: argparse.Namespace) -> dict[str, Any]:
    """Measure the artifacts in a downloaded bundle and write the evidence.

    The helper is read-only.  It opens the bundle directory, measures each
    named component, and never changes a host, a registry, or a deployment.
    """

    bundle = Path(args.bundle).resolve()
    if not bundle.is_dir():
        fail(f"release bundle is not a directory: {bundle}")
    release_id = require_id(args.release_id, "release ID")
    manifest = load_json(Path(args.manifest), "release bundle manifest")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        fail("release bundle manifest has an unsupported schema version")
    if manifest.get("kind") != "intar-release-bundle":
        fail("release bundle manifest must have kind intar-release-bundle")
    require_keys(manifest, RELEASE_BUNDLE_MANIFEST_KEYS, "release bundle manifest")
    if require_id(manifest.get("release_id"), "release bundle manifest release ID") != release_id:
        fail("release bundle manifest release ID does not match the requested release ID")
    manifest_components = require_object(
        manifest.get("components"), "release bundle manifest components"
    )
    if set(manifest_components) != set(RELEASE_COMPONENTS):
        fail("release bundle manifest must name exactly " + ", ".join(RELEASE_COMPONENTS))
    components: dict[str, dict[str, Any]] = {}
    for component in RELEASE_COMPONENTS:
        item = require_object(manifest_components[component], f"release bundle manifest {component}")
        require_keys(item, RELEASE_BUNDLE_COMPONENT_KEYS, f"release bundle manifest {component}")
        relative = require_string(item.get("file"), f"release bundle component {component} file")
        if relative.startswith("/") or ".." in Path(relative).parts:
            fail(f"release bundle component {component} file must stay inside the bundle")
        path = (bundle / relative).resolve()
        if not path.is_file():
            fail(f"release bundle component {component} file is missing: {relative}")
        record: dict[str, Any] = {
            "id": require_id(item.get("id"), f"release bundle manifest {component} ID"),
            "file": relative,
            "sha256": sha256_file(path, f"release bundle component {component}"),
            "size_bytes": path.stat().st_size,
        }
        if component == "images":
            record["kino_abi"] = require_kino_abi(
                item.get("kino_abi"), "release bundle images"
            )
        components[component] = record
    digest_source = {
        component: {
            "file": components[component]["file"],
            "sha256": components[component]["sha256"],
            "size_bytes": components[component]["size_bytes"],
        }
        for component in RELEASE_COMPONENTS
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": RELEASE_EVIDENCE_KIND,
        "release_id": release_id,
        "measured_unix_ms": now_unix_ms(),
        "network_actions": "none",
        "bundle_digest_sha256": hashlib.sha256(canonical_json(digest_source)).hexdigest(),
        "components": components,
    }


def parse_run_manifest_scenarios(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        fail("run manifest scenarios must be a nonempty list")
    scenarios: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in value:
        item = require_object(entry, "run manifest scenario")
        require_keys(item, SCENARIO_KEYS, "run manifest scenario")
        scenario_id = require_id(item.get("id"), "run manifest scenario ID")
        if scenario_id in seen:
            fail(f"run manifest repeats a scenario: {scenario_id}")
        seen.add(scenario_id)
        scenarios.append(
            {
                "id": scenario_id,
                "vm_count": require_int(
                    item.get("vm_count"), f"scenario {scenario_id} VM count", 1
                ),
            }
        )
    return scenarios


def load_run_manifest(path: Path) -> tuple[dict[str, Any], str]:
    """Validate the run plan, the isolated host, and the release evidence."""

    manifest = load_json(path, "run manifest")
    manifest_sha256 = sha256_file(path, "run manifest")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        fail("run manifest has an unsupported schema version")
    if manifest.get("kind") != RUN_MANIFEST_KIND:
        fail(f"run manifest must have kind {RUN_MANIFEST_KIND}")
    require_keys(manifest, RUN_MANIFEST_KEYS, "run manifest")
    foreground = require_object(manifest.get("foreground_workload"), "run manifest foreground workload")
    require_keys(foreground, FOREGROUND_WORKLOAD_KEYS, "run manifest foreground workload")
    host = require_object(manifest.get("host"), "run manifest host")
    require_keys(host, HOST_KEYS, "run manifest host")
    for key in ("controller", "controller_lease_id", "isolation_id", "cpu_class", "region"):
        require_id(host.get(key), f"run manifest host {key}")
    role = require_id(host.get("role"), "run manifest host role")
    if role not in HOST_ROLES:
        fail("run manifest host role must be one of " + ", ".join(HOST_ROLES))
    if not isinstance(host.get("serves_learners"), bool):
        fail("run manifest host serves_learners must be a boolean")
    if host.get("serves_learners") and role != "drained-production":
        fail("only a drained production host may serve learners")
    if not isinstance(host.get("production"), bool):
        fail("run manifest host production must be a boolean")
    if role == "drained-production" and host.get("production") is not True:
        fail(
            "a drained production host must declare production=true:"
            " the production flag states what the host is"
        )
    if role in ("isolated-benchmark", "ci-runner") and host.get("production") is not False:
        fail("only the drained-production role may declare production=true")
    require_id(host.get("hardware_class"), "run manifest host hardware class")
    comparability = require_object(manifest.get("comparability"), "run manifest comparability")
    require_keys(comparability, COMPARABILITY_KEYS, "run manifest comparability")
    reference_class = require_id(
        comparability.get("reference_class"), "run manifest reference class"
    )
    measured_class = require_id(
        comparability.get("measured_class"), "run manifest measured class"
    )
    matches_reference = comparability.get("matches_reference")
    if not isinstance(matches_reference, bool):
        fail("run manifest comparability matches_reference must be a boolean")
    if matches_reference and measured_class != reference_class:
        fail(
            "run manifest comparability claims a match while the measured class is"
            f" {measured_class} and the reference class is {reference_class}"
        )
    comparability_reason = require_string(
        comparability.get("reason"), "run manifest comparability reason"
    )
    client = require_object(manifest.get("client"), "run manifest client")
    require_keys(client, CLIENT_KEYS, "run manifest client")
    if client.get("region") != CLIENT_REGION:
        fail(f"run manifest client region must be {CLIENT_REGION}")
    observed_rtt = require_object(client.get("observed_rtt_ms"), "run manifest client observed RTT")
    require_keys(observed_rtt, CLIENT_RTT_RANGE_KEYS, "run manifest client observed RTT")
    rtt_min = require_int(observed_rtt.get("min_ms"), "run manifest client observed RTT minimum", 1)
    rtt_max = require_int(observed_rtt.get("max_ms"), "run manifest client observed RTT maximum", 1)
    if rtt_max < rtt_min:
        fail("run manifest client observed RTT maximum must not be below its minimum")
    if rtt_max - rtt_min > MAX_RTT_TOLERANCE_MS:
        fail(
            "run manifest client observed RTT range must not exceed "
            f"{MAX_RTT_TOLERANCE_MS} ms"
        )
    participants_source = manifest.get("participants")
    if not isinstance(participants_source, list):
        fail("run manifest participants must be a list")
    participants = [require_id(value, "run manifest participant") for value in participants_source]
    if len(set(participants)) != len(participants):
        fail("run manifest repeats a participant")
    if len(participants) < CONCURRENT_PARTICIPANTS:
        fail(f"run manifest needs at least {CONCURRENT_PARTICIPANTS} distinct participants")
    scenarios = parse_run_manifest_scenarios(manifest.get("scenarios"))
    if len(scenarios) != REQUIRED_SCENARIO_COUNT:
        fail(f"run manifest must plan exactly {REQUIRED_SCENARIO_COUNT} scenarios")
    host_attestation = load_host_attestation(
        resolve_relative_file(
            path.resolve().parent, host.get("attestation_file"), "host attestation file"
        ),
        host,
    )
    base = path.resolve().parent
    releases = require_object(manifest.get("releases"), "run manifest releases")
    if set(releases) != set(IMPLEMENTATIONS):
        fail("run manifest releases must be exactly baseline and candidate")
    resolved_releases: dict[str, Any] = {}
    for implementation in IMPLEMENTATIONS:
        reference = require_object(releases[implementation], f"{implementation} release")
        require_keys(reference, RELEASE_REFERENCE_KEYS, f"{implementation} release")
        release_id = require_id(reference.get("id"), f"{implementation} release ID")
        evidence_path = resolve_relative_file(
            base, reference.get("evidence_file"), f"{implementation} release evidence file"
        )
        resolved_releases[implementation] = load_release_evidence(evidence_path, release_id)
    if (
        resolved_releases["baseline"]["evidence_sha256"]
        == resolved_releases["candidate"]["evidence_sha256"]
    ):
        fail("baseline and candidate releases must use different release evidence")
    # The variant decides the ABI rule, so no operator flag can move it. The
    # candidate is the release under test and must carry the current image
    # ABI. The baseline is the artifact that is already deployed, so it may
    # still carry the older ABI, and the comparison has to measure it as it
    # is. This is benchmark measurability, not runtime backward compatibility.
    if resolved_releases["candidate"]["images_kino_abi"] != KINO_ABI:
        fail(
            f"candidate release images must pin Kino ABI {KINO_ABI},"
            f" got {resolved_releases['candidate']['images_kino_abi']}"
        )
    workloads_source = require_object(
        manifest.get("background_workloads"), "run manifest background workloads"
    )
    if set(workloads_source) != set(BACKGROUND_WORKLOAD_KEYS):
        fail(
            "run manifest background workloads must be exactly "
            + ", ".join(BACKGROUND_WORKLOAD_KEYS)
        )
    background_workloads: dict[str, Any] = {}
    for key in BACKGROUND_WORKLOAD_KEYS:
        item = require_object(workloads_source[key], f"background workload {key}")
        require_keys(item, BACKGROUND_WORKLOAD_FIELDS, f"background workload {key}")
        window = require_object(item.get("window"), f"background workload {key} window")
        require_keys(window, BACKGROUND_WINDOW_KEYS, f"background workload {key} window")
        start = require_int(window.get("start_unix_ms"), f"background workload {key} window start", 1)
        end = require_int(window.get("end_unix_ms"), f"background workload {key} window end", 1)
        if end <= start:
            fail(f"background workload {key} window must end after it starts")
        background_workloads[key] = {
            "workload_id": require_id(item.get("workload_id"), f"background workload {key} ID"),
            "rate_per_min": require_int(item.get("rate_per_min"), f"background workload {key} rate", 1),
            "window": {"start_unix_ms": start, "end_unix_ms": end},
        }
    randomization = require_object(manifest.get("randomization"), "run manifest randomization")
    require_keys(randomization, frozenset({"seed"}), "run manifest randomization")
    require_string(randomization.get("seed"), "run manifest randomization seed")
    return {
        "run_id": require_id(manifest.get("run_id"), "run ID"),
        "claim_ceiling": CLAIM_CEILINGS[role],
        "foreground_workload": {
            "workload_id": require_id(
                foreground.get("workload_id"), "foreground workload ID"
            ),
            "controller": require_id(foreground.get("controller"), "foreground workload controller"),
            "controller_lease_id": require_id(
                foreground.get("controller_lease_id"), "foreground workload controller lease ID"
            ),
        },
        "host": {
            "controller": host["controller"],
            "controller_lease_id": host["controller_lease_id"],
            "isolation_id": host["isolation_id"],
            "cpu_class": host["cpu_class"],
            "region": host["region"],
            "role": role,
            "production": host["production"],
            "serves_learners": host["serves_learners"],
            "hardware_class": host["hardware_class"],
            "attestation": host_attestation,
        },
        "comparability": {
            "reference_class": reference_class,
            "measured_class": measured_class,
            "matches_reference": matches_reference,
            "reason": comparability_reason,
        },
        "client": {
            "region": client["region"],
            "observed_rtt_ms": {"min_ms": rtt_min, "max_ms": rtt_max},
        },
        "participants": participants,
        "scenarios": scenarios,
        "releases": resolved_releases,
        "background_workloads": background_workloads,
        "randomization": {"seed": randomization["seed"]},
    }, manifest_sha256


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


def create_plan(
    manifest: dict[str, Any],
    manifest_sha256: str,
    plan_id: str,
    samples_per_implementation: int = SAMPLES_PER_IMPLEMENTATION,
    block_size: int = BLOCK_SIZE,
    conditions: tuple[str, ...] = DEFAULT_CONDITIONS,
    plan_role: str = "full",
) -> dict[str, Any]:
    """Write the deterministic schedule for one measured release pair.

    The block order and the first implementation in each block come from the
    run manifest seed.  The same seed and manifest make the same schedule, so
    an operator can rebuild a plan and compare it with the recorded one.
    """

    plan_id = require_id(plan_id, "plan ID")
    samples = require_int(samples_per_implementation, "samples per implementation", 1)
    block_size = require_int(block_size, "block size", 1)
    if samples % block_size != 0:
        fail("samples per implementation must divide exactly into the block size")
    scenarios = [scenario["id"] for scenario in manifest["scenarios"]]
    scenario_vm_counts = {
        scenario["id"]: scenario["vm_count"] for scenario in manifest["scenarios"]
    }
    participants = list(manifest["participants"])
    if not conditions:
        fail("at least one condition is required")
    for condition in conditions:
        if condition not in CONDITIONS:
            fail(f"unknown condition: {condition}")
        if block_size % CONDITIONS[condition]["launch_concurrency"]:
            fail(f"block size must divide exactly into {condition} launch concurrency")
        if (
            CONDITIONS[condition]["launch_concurrency"] > 1
            and block_size != CONDITIONS[condition]["launch_concurrency"]
        ):
            fail(f"{condition} requires a block size equal to its launch concurrency")
        if len(participants) < CONDITIONS[condition]["launch_concurrency"]:
            fail(f"{condition} needs at least {CONDITIONS[condition]['launch_concurrency']} distinct participants")

    baseline = release_record(
        manifest["releases"]["baseline"]["id"],
        manifest["releases"]["baseline"]["evidence_sha256"],
    )
    candidate = release_record(
        manifest["releases"]["candidate"]["id"],
        manifest["releases"]["candidate"]["evidence_sha256"],
    )
    schedule: list[dict[str, Any]] = []
    next_group = 1
    blocks_per_implementation = samples // block_size
    rng = random.Random(manifest["randomization"]["seed"])
    block_order: list[dict[str, Any]] = []
    for condition in conditions:
        pairs = [
            (block_index, scenario_id)
            for block_index in range(blocks_per_implementation)
            for scenario_id in scenarios
        ]
        rng.shuffle(pairs)
        for block_index, scenario_id in pairs:
            block_order.append(
                {
                    "condition": condition,
                    "block_index": block_index + 1,
                    "scenario_id": scenario_id,
                    "first_implementation": rng.choice(list(IMPLEMENTATIONS)),
                }
            )
    for block in block_order:
        condition = block["condition"]
        settings = CONDITIONS[condition]
        block_index = block["block_index"] - 1
        scenario_id = block["scenario_id"]
        implementations = (
            block["first_implementation"],
            "candidate" if block["first_implementation"] == "baseline" else "baseline",
        )
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
                        "background_workload": settings["background_workload"],
                    }
                )

    plan: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan_id,
        "plan_role": plan_role,
        "created_unix_ms": now_unix_ms(),
        "run_id": manifest["run_id"],
        "run_manifest_sha256": manifest_sha256,
        "host": manifest["host"],
        "host_attestation": manifest["host"]["attestation"],
        "foreground_workload": manifest["foreground_workload"],
        "client": manifest["client"],
        "background_workloads": manifest["background_workloads"],
        "primary_metric": "terminal_first_command_ms",
        "percentile_method": "nearest-rank",
        "targets": {
            "p50_ms": P50_TARGET_MS,
            "p95_ms": P95_TARGET_MS,
            "samples_per_cell": samples,
            "gated_implementations": ["candidate"],
            "max_candidate_failures_per_cell": 0,
        },
        "scenarios": list(scenarios),
        "scenario_vm_counts": scenario_vm_counts,
        "participants": list(participants),
        "conditions": list(conditions),
        "samples_per_implementation": samples,
        "block_size": block_size,
        "randomization": {
            "seed": manifest["randomization"]["seed"],
            "algorithm": "seeded-shuffle-v1",
            "block_order": block_order,
        },
        "releases": {"baseline": baseline, "candidate": candidate},
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
    require_sha256(plan.get("run_manifest_sha256"), "plan run manifest SHA-256")
    if plan.get("conditions") != list(DEFAULT_CONDITIONS):
        # A plan may restrict the conditions, for example a smoke plan. Every
        # listed condition must be a real one, and a plan that names none is
        # refused earlier by the schedule checks.
        for condition in plan.get("conditions") or []:
            if condition not in CONDITIONS:
                fail(f"plan has an unknown condition: {condition}")
    targets = require_object(plan.get("targets"), "plan targets")
    if targets.get("p50_ms") != P50_TARGET_MS or targets.get("p95_ms") != P95_TARGET_MS:
        fail("plan targets are not the authoritative p50 and p95 targets")
    plan_role = plan.get("plan_role", "full")
    if plan_role not in PLAN_ROLES:
        fail("plan role must be one of " + ", ".join(PLAN_ROLES))
    plan_conditions = tuple(plan.get("conditions") or ())
    if not plan_conditions:
        fail("plan names no condition")
    clients = require_object(plan.get("client"), "plan client")
    require_keys(clients, CLIENT_KEYS, "plan client")
    if clients.get("region") != CLIENT_REGION:
        fail("plan client region is not the authoritative EU client")
    observed_rtt = require_object(clients.get("observed_rtt_ms"), "plan client observed RTT")
    require_keys(observed_rtt, CLIENT_RTT_RANGE_KEYS, "plan client observed RTT")
    require_int(observed_rtt.get("min_ms"), "plan client observed RTT minimum", 1)
    require_int(observed_rtt.get("max_ms"), "plan client observed RTT maximum", 1)
    plan_host = require_object(plan.get("host"), "plan host")
    attestation = require_object(plan.get("host_attestation"), "plan host attestation")
    require_sha256(attestation.get("sha256"), "plan host attestation SHA-256")
    require_id(attestation.get("hostname"), "plan host attestation hostname")
    require_string(attestation.get("hardware"), "plan host attestation hardware")
    require_int(attestation.get("cpu_cores"), "plan host attestation CPU cores", 1)
    require_int(attestation.get("memory_mib"), "plan host attestation memory MiB", 1)
    if require_int(attestation.get("active_vms"), "plan host attestation active VMs") != 0:
        fail("plan host attestation reports active VMs")
    if attestation.get("environment") != "benchmark":
        fail("plan host attestation environment is not benchmark")
    if not isinstance(attestation.get("production"), bool):
        fail("plan host attestation production must be a boolean")
    if attestation.get("production") != plan_host.get("production"):
        fail("plan host attestation production does not match the plan host")
    plan_host_role = require_id(plan_host.get("role"), "plan host role")
    if plan_host_role not in HOST_ROLES:
        fail("plan host role is not a known role")
    if attestation.get("role") != plan_host_role:
        fail("plan host attestation role does not match the plan host")
    if plan_host_role == "drained-production" and attestation.get("production") is not True:
        fail("a drained production plan must state production=true")
    require_object(plan.get("foreground_workload"), "plan foreground workload")
    workloads = require_object(plan.get("background_workloads"), "plan background workloads")
    if set(workloads) != set(BACKGROUND_WORKLOAD_KEYS):
        fail("plan background workloads are not the authoritative workload set")
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
    cell_counts: dict[tuple[str, str, str], int] = {}
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
        if item.get("background_workload") != CONDITIONS[item["condition"]]["background_workload"]:
            fail("plan sample background workload does not match its condition")
        if item.get("cache_mode") != CONDITIONS[item["condition"]]["cache_mode"]:
            fail("plan sample cache mode does not match its condition")
        expected_vm_count = require_int(item.get("expected_vm_count"), "plan expected VM count", 1)
        if expected_vm_count != require_int(
            scenario_counts.get(item.get("scenario_id")), "plan scenario VM count", 1
        ):
            fail("plan sample VM count does not match scenario topology")
        require_id(item.get("participant_id"), "plan participant ID")
        release = require_object(item.get("release"), "plan release")
        release_record(release.get("id"), release.get("manifest_sha256"))
        cell_counts[(item["scenario_id"], item["condition"], item["implementation"])] = (
            cell_counts.get((item["scenario_id"], item["condition"], item["implementation"]), 0)
            + 1
        )
    expected_cells = {
        (scenario_id, condition, implementation)
        for scenario_id in scenario_counts
        for condition in plan_conditions
        for implementation in IMPLEMENTATIONS
    }
    if set(cell_counts) != expected_cells:
        fail("plan does not cover each scenario, condition, and implementation cell")
    for cell, count in cell_counts.items():
        if count != require_int(plan.get("samples_per_implementation"), "plan samples", 1):
            fail(f"plan cell {'/'.join(cell)} does not have the planned sample count")
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
    source: dict[str, Any],
    expected_run_id: str,
    expected_scenario_id: str,
    require_terminal_visible: bool,
) -> dict[str, Any]:
    run_id = require_run_id(source.get("runId"), "browser runId")
    if run_id != expected_run_id:
        fail("browser evidence runId does not match the requested run")
    scenario_id = require_id(source.get("scenarioId"), "browser scenarioId")
    if scenario_id != expected_scenario_id:
        fail("browser evidence scenarioId does not match the planned sample")
    start = require_int(source.get("startUnixMs"), "browser startUnixMs")
    connected = require_int(source.get("terminalConnectedUnixMs"), "browser terminalConnectedUnixMs")
    client_rtt_ms = require_int(source.get("clientRttMs"), "browser client RTT", 1)
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
    # A reused run must carry the durable control-plane acceptance time. The
    # collector records which clock produced the value, so a release whose reuse
    # path returns a response clock cannot pass a reused sample.
    start_reused = source.get("startReused")
    if start_reused is not None and not isinstance(start_reused, bool):
        fail("browser evidence startReused must be a boolean")
    accepted_unix_source = source.get("acceptedUnixSource")
    if accepted_unix_source is not None and accepted_unix_source not in (
        "control-plane",
        "browser-receive",
    ):
        fail("browser evidence acceptedUnixSource has an unsupported value")
    if start_reused is True and accepted_unix_source != "control-plane":
        fail(
            "a reused run needs the durable control-plane acceptance time:"
            " a response clock cannot prove which attempt created the run"
        )
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
    # The visible mark proves the learner could see and use the terminal before
    # the collector sent its command. A socket that answers with the nonce while
    # the terminal stays hidden cannot satisfy this, because the mark is only
    # written after the collector observes a visible terminal in the page.
    visible = normalized_stages.get(TERMINAL_VISIBLE_STAGE)
    if visible is None:
        if require_terminal_visible:
            fail(
                "browser evidence is missing the "
                + TERMINAL_VISIBLE_STAGE
                + " mark: a candidate sample needs a visible terminal before the first command"
            )
    else:
        if visible < connected:
            fail(
                "browser evidence terminal-visible mark is before the terminal-connected mark"
            )
        if visible > command_started:
            fail(
                "browser evidence terminal-visible mark is after the first command started"
            )
    return {
        "runId": run_id,
        "scenarioId": scenario_id,
        "startUnixMs": start,
        "terminalConnectedUnixMs": connected,
        "clientRttMs": client_rtt_ms,
        **({"startReused": start_reused} if start_reused is not None else {}),
        **(
            {"acceptedUnixSource": accepted_unix_source}
            if accepted_unix_source is not None
            else {}
        ),
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


def load_host_attestation(
    path: Path, host: Mapping[str, Any], name: str = "host attestation"
) -> dict[str, Any]:
    """Read the proof that the host is the isolated benchmark host.

    The proof is a file that an operator with root access provisioned on the
    host and that the trusted host adapter read back.  The tool compares every
    identity field with the run manifest and refuses an unverified file, a
    production host, a different environment, or a host that still has active
    VMs.  A plan cannot be written without this file, so no campaign and no
    passing gate exists without it.
    """

    attestation = load_json(path, name)
    if attestation.get("schema_version") != SCHEMA_VERSION:
        fail(f"{name} has an unsupported schema version")
    if attestation.get("kind") != HOST_ATTESTATION_KIND:
        fail(f"{name} must have kind {HOST_ATTESTATION_KIND}")
    require_keys(attestation, HOST_ATTESTATION_KEYS, name)
    if attestation.get("verified") is not True:
        fail(f"{name} is not verified by the host adapter")
    if attestation.get("environment") != "benchmark":
        fail(f"{name} must state environment benchmark")
    role = require_id(attestation.get("role"), f"{name} role")
    if role not in HOST_ROLES:
        fail(f"{name} role must be one of " + ", ".join(HOST_ROLES))
    if role != host.get("role"):
        fail(
            f"{name} role {role} does not match the run manifest role {host.get('role')}"
        )
    if not isinstance(attestation.get("serves_learners"), bool):
        fail(f"{name} serves_learners must be a boolean")
    if attestation.get("serves_learners") != host.get("serves_learners"):
        fail(f"{name} serves_learners does not match the run manifest")
    if not isinstance(attestation.get("production"), bool):
        fail(f"{name} production must be a boolean")
    if attestation.get("production") != host.get("production"):
        fail(
            f"{name} production {attestation.get('production')} does not match"
            f" the run manifest production {host.get('production')}"
        )
    require_id(attestation.get("hardware_class"), f"{name} hardware class")
    if attestation.get("hardware_class") != host.get("hardware_class"):
        fail(
            f"{name} hardware class {attestation.get('hardware_class')} does not match"
            f" the run manifest hardware class {host.get('hardware_class')}"
        )
    for key in ("isolation_id", "controller", "controller_lease_id", "cpu_class", "region"):
        if attestation.get(key) != host.get(key):
            fail(
                f"{name} {key} does not match the run manifest"
                f" (host {attestation.get(key)!r}, manifest {host.get(key)!r})"
            )
    active_vms = require_int(attestation.get("active_vms"), f"{name} active VM count")
    if active_vms != 0:
        fail(f"{name} reports {active_vms} active VMs; the benchmark host must be empty")
    return {
        "sha256": sha256_file(path, name),
        "hostname": require_id(attestation.get("hostname"), f"{name} hostname"),
        "hardware": require_string(attestation.get("hardware"), f"{name} hardware"),
        "cpu_cores": require_int(attestation.get("cpu_cores"), f"{name} CPU cores", 1),
        "memory_mib": require_int(attestation.get("memory_mib"), f"{name} memory MiB", 1),
        "active_vms": active_vms,
        "environment": attestation["environment"],
        "role": role,
        "production": attestation["production"],
        "serves_learners": attestation["serves_learners"],
        "hardware_class": attestation["hardware_class"],
        "basis": require_string(attestation.get("basis"), f"{name} basis"),
        "captured_unix_ms": require_int(
            attestation.get("captured_unix_ms"), f"{name} capture time", 1
        ),
    }


def workload_events(path: Path, name: str = "workload events") -> list[dict[str, Any]]:
    """Read the host workload events that the trusted adapter observed."""

    document = load_json(path, name)
    if document.get("schema_version") != SCHEMA_VERSION:
        fail(f"{name} has an unsupported schema version")
    if document.get("kind") != WORKLOAD_EVENTS_KIND:
        fail(f"{name} must have kind {WORKLOAD_EVENTS_KIND}")
    require_keys(document, WORKLOAD_EVENTS_KEYS, name)
    require_id(document.get("host"), f"{name} host")
    source = document.get("events")
    if not isinstance(source, list) or not source:
        fail(f"{name} has no events")
    events: list[dict[str, Any]] = []
    for entry in source:
        event = require_object(entry, f"{name} event")
        require_keys(event, WORKLOAD_EVENT_KEYS, f"{name} event")
        kind = require_id(event.get("kind"), f"{name} event kind")
        if kind not in WORKLOAD_EVENT_KINDS:
            fail(f"{name} event kind must be one of {', '.join(WORKLOAD_EVENT_KINDS)}")
        events.append(
            {
                "unix_ms": require_int(event.get("unix_ms"), f"{name} event time", 1),
                "workload": require_id(event.get("workload"), f"{name} event workload"),
                "kind": kind,
                "job": require_id(event.get("job"), f"{name} event job"),
                "source": require_string(event.get("source"), f"{name} event source"),
                "message": require_string(event.get("message"), f"{name} event message"),
            }
        )
    return events


def workload_intervals(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Fold workload events into one interval per workload and job.

    An interval opens at a start event and closes at an end event. A start
    without an end stays open, because the work is still running or still
    queued: the background worker parks between blocks while a VM boot is
    critical, so a boot window can contain no event of its own while the
    workload is plainly present.
    """

    open_jobs: dict[tuple[str, str], int] = {}
    intervals: dict[str, list[dict[str, Any]]] = {}
    for event in sorted(events, key=lambda item: item["unix_ms"]):
        identity = (event["workload"], event["job"])
        if event["kind"] == "start":
            open_jobs.setdefault(identity, event["unix_ms"])
            continue
        opened = open_jobs.pop(identity, event["unix_ms"])
        intervals.setdefault(event["workload"], []).append(
            {
                "job": event["job"],
                "start_unix_ms": min(opened, event["unix_ms"]),
                "end_unix_ms": event["unix_ms"],
                "open": False,
                "source": event["source"],
            }
        )
    for (workload, job), opened in sorted(open_jobs.items()):
        intervals.setdefault(workload, []).append(
            {
                "job": job,
                "start_unix_ms": opened,
                "end_unix_ms": None,
                "open": True,
                "source": "intar-agent",
            }
        )
    return intervals


def interval_covers_window(interval: dict[str, Any], window: tuple[int, int]) -> bool:
    """True when the interval was active at any moment of the window.

    An open interval that started before the window is still active, so it
    covers the window. A closed interval covers the window when it starts at
    or before the window end and ends at or after the window start.
    """

    window_start, window_end = window
    if interval["start_unix_ms"] > window_end:
        return False
    end = interval["end_unix_ms"]
    return end is None or end >= window_start


def workload_overlap(
    events: list[dict[str, Any]], declared_key: str, window: tuple[int, int]
) -> dict[str, Any]:
    """Prove that every workload of a condition was active across one window.

    The declared workload ID and rate are operator inputs. This function only
    accepts host intervals that really span the sample window, so a declared
    window that no workload touched fails the sample. A combined condition
    needs every one of its workloads, so cache-refresh+archive fails when the
    archive half is not proven.
    """

    required = OBSERVABLE_WORKLOADS.get(declared_key)
    if required is None:
        fail(f"background workload {declared_key} has no observable proof")
    intervals = workload_intervals(events)
    evidence: dict[str, Any] = {}
    missing: list[str] = []
    for workload in required:
        covering = [
            interval
            for interval in intervals.get(workload, [])
            if interval_covers_window(interval, window)
        ]
        if not covering:
            missing.append(workload)
            continue
        covering.sort(key=lambda item: item["start_unix_ms"])
        chosen = covering[0]
        evidence[workload] = {
            "job": chosen["job"],
            "start_unix_ms": chosen["start_unix_ms"],
            "end_unix_ms": chosen["end_unix_ms"],
            "open": chosen["open"],
            "overlap_count": len(covering),
        }
    if missing:
        fail(
            "the background workload is not proven to overlap the sample window"
            f" ({window[0]}..{window[1]} ms); no active interval for: "
            + ", ".join(missing)
        )
    return {
        "required_workloads": list(required),
        "observed_workloads": list(required),
        "evidence": evidence,
        "observed_event_count": len(
            [
                event
                for event in events
                if event["workload"] in required and event["unix_ms"] <= window[1]
            ]
        ),
    }


def require_client_rtt(plan: dict[str, Any], client_rtt_ms: int) -> int:
    """Keep every sample inside the client RTT range that the run recorded.

    The range is an operator measurement of the same client that runs the
    campaign, not a fixed constant.  A sample outside it is not a sample of
    the same client population.
    """

    observed = require_object(
        require_object(plan.get("client"), "plan client").get("observed_rtt_ms"),
        "plan client observed RTT",
    )
    minimum = require_int(observed.get("min_ms"), "plan client observed RTT minimum", 1)
    maximum = require_int(observed.get("max_ms"), "plan client observed RTT maximum", 1)
    value = require_int(client_rtt_ms, "client RTT", 1)
    if not (minimum <= value <= maximum):
        fail(
            "client RTT is outside the observed range recorded in the run manifest "
            f"({value} ms against {minimum}..{maximum} ms)"
        )
    return value


def workload_record(
    plan: dict[str, Any],
    expected: dict[str, Any],
    background_workload_id: str | None,
    sample_window: tuple[int, int] | None,
) -> dict[str, Any]:
    """Name the foreground and background workloads for one sample."""

    key = expected["background_workload"]
    record: dict[str, Any] = {"foreground_id": plan["foreground_workload"]["workload_id"]}
    if key is None:
        if background_workload_id is not None:
            fail("a background workload ID is only valid for a background workload condition")
        return record
    declared = require_object(
        require_object(plan.get("background_workloads"), "plan background workloads").get(key),
        f"plan background workload {key}",
    )
    declared_id = require_id(declared.get("workload_id"), f"plan background workload {key} ID")
    workload_id = require_id(background_workload_id, f"background workload {key} ID")
    if workload_id != declared_id:
        fail(f"background workload ID does not match the planned {key} workload")
    window = require_object(declared.get("window"), f"plan background workload {key} window")
    record.update(
        {
            "background_key": key,
            "background_id": workload_id,
            "background_rate_per_min": require_int(
                declared.get("rate_per_min"), f"plan background workload {key} rate", 1
            ),
            "window_start_unix_ms": require_int(
                window.get("start_unix_ms"), f"plan background workload {key} window start", 1
            ),
            "window_end_unix_ms": require_int(
                window.get("end_unix_ms"), f"plan background workload {key} window end", 1
            ),
        }
    )
    if sample_window is not None:
        sample_start, sample_end = sample_window
        if sample_start < record["window_start_unix_ms"] or sample_end > record["window_end_unix_ms"]:
            fail(f"sample window is outside the declared {key} workload window")
        record["sample_start_unix_ms"] = sample_start
        record["sample_end_unix_ms"] = sample_end
    return record


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
    client_rtt_ms = (
        None if args.client_rtt_ms is None else require_client_rtt(plan, args.client_rtt_ms)
    )
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan["plan_id"],
        "plan_sha256": plan["plan_sha256"],
        "run_manifest_sha256": plan["run_manifest_sha256"],
        "sample_id": expected["sample_id"],
        "scenario_id": expected["scenario_id"],
        "condition": expected["condition"],
        "implementation": expected["implementation"],
        "participant_id": participant_id,
        "release": expected["release"],
        "cache_mode": expected["cache_mode"],
        "background_workload": expected["background_workload"],
        "recorded_unix_ms": now_unix_ms(),
        "status": status,
    }
    if client_rtt_ms is not None:
        record["client_rtt_ms"] = client_rtt_ms
    if status == "failure":
        if args.failure_code is None:
            fail("failure samples need a failure code")
        if not SAFE_FAILURE_CODE.fullmatch(args.failure_code):
            fail("failure code has an invalid format")
        if args.workload_events is not None:
            fail("workload events are only valid for a successful background sample")
        if args.run_id:
            if args.teardown not in ("destroyed", "failed"):
                fail("a failed run needs --teardown destroyed or failed")
            record["teardown"] = args.teardown
        else:
            if args.teardown != "not-needed":
                fail("a failed start with no run needs --teardown not-needed")
            record["teardown"] = "not-needed"
        record["failure_code"] = args.failure_code
        record["workload"] = workload_record(plan, expected, args.cache_refresh_id, None)
    else:
        if not args.run_id or not args.browser_evidence or not args.agent_events or not args.host_delta:
            fail("success samples need run ID, browser evidence, agent events, and host delta")
        if client_rtt_ms is None:
            fail("success samples need the measured client RTT")
        if args.teardown not in ("destroyed", "failed"):
            fail("success samples need --teardown destroyed or failed")
        run_id = require_run_id(args.run_id)
        browser_source = load_json(Path(args.browser_evidence), "browser evidence")
        validate_browser_runner_metadata(browser_source, expected, participant_id)
        browser = normalize_browser_evidence(
            browser_source,
            run_id,
            expected["scenario_id"],
            expected["implementation"] == "candidate",
        )
        if browser["clientRttMs"] != client_rtt_ms:
            fail("browser evidence client RTT does not match the recorded client RTT")
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
        record["teardown"] = args.teardown
        record["readiness"] = {
            "host_security": {
                "phase": HOST_SECURITY_PHASE,
                "slowest_vm_ms": slowest_agent_phase(agent, HOST_SECURITY_PHASE),
            },
            "recorded_pty": {
                "nonce_sha256": browser["firstCommand"]["nonceSha256"],
                "output_unix_ms": browser["firstCommand"]["successUnixMs"],
            },
            "basis": ["host-security-seal", "recorded-pty-output"],
        }
        record["workload"] = workload_record(
            plan,
            expected,
            args.cache_refresh_id,
            (browser["startUnixMs"], browser["firstCommand"]["successUnixMs"]),
        )
        if expected["background_workload"] is None:
            if args.workload_events is not None:
                fail("workload events are only valid for a background workload condition")
        else:
            if not args.workload_events:
                fail(
                    "a background workload sample needs --workload-events:"
                    " the declared window must be proven by real host events"
                )
            record["workload"].update(
                workload_overlap(
                    workload_events(Path(args.workload_events)),
                    expected["background_workload"],
                    (browser["startUnixMs"], browser["firstCommand"]["successUnixMs"]),
                )
            )
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
    if observation.get("run_manifest_sha256") != plan["run_manifest_sha256"]:
        fail(f"{expected['sample_id']}: observation is from a different run manifest")
    for key in (
        "sample_id",
        "scenario_id",
        "condition",
        "implementation",
        "participant_id",
        "cache_mode",
        "background_workload",
    ):
        if observation.get(key) != expected[key]:
            fail(f"{expected['sample_id']}: observation {key} does not match the plan")
    if observation.get("release") != expected["release"]:
        fail(f"{expected['sample_id']}: observation release does not match the plan")
    status = observation.get("status")
    teardown = observation.get("teardown")
    if teardown not in TEARDOWN_STATES:
        fail(f"{expected['sample_id']}: observation has no teardown outcome")
    if status == "failure":
        code = observation.get("failure_code")
        if not isinstance(code, str) or not SAFE_FAILURE_CODE.fullmatch(code):
            fail(f"{expected['sample_id']}: failure has an invalid failure code")
        if observation.get("runtime_run_id") is not None and teardown == "not-needed":
            fail(f"{expected['sample_id']}: a failed run must record its teardown outcome")
        workload = require_object(observation.get("workload"), "failure workload")
        if workload.get("foreground_id") != plan["foreground_workload"]["workload_id"]:
            fail(f"{expected['sample_id']}: failure workload is not the planned foreground workload")
        if expected["background_workload"] is not None:
            if "background_id" not in workload:
                fail(
                    f"{expected['sample_id']}: failure for a background workload condition has no workload ID"
                )
        elif "background_id" in workload:
            fail(f"{expected['sample_id']}: failure workload has an unexpected background workload")
        return observation
    if status != "success":
        fail(f"{expected['sample_id']}: observation has an invalid status")
    if teardown not in ("destroyed", "failed"):
        fail(
            f"{expected['sample_id']}: a successful sample must record its teardown outcome"
        )
    client_rtt_ms = require_client_rtt(plan, observation.get("client_rtt_ms"))
    run_id = require_run_id(observation.get("runtime_run_id"), "runtime run ID")
    browser = normalize_browser_evidence(
        require_object(observation.get("browser"), "browser evidence"),
        run_id,
        expected["scenario_id"],
        expected["implementation"] == "candidate",
    )
    if browser["clientRttMs"] != client_rtt_ms:
        fail(f"{expected['sample_id']}: browser client RTT does not match the observation")
    agent_source = require_object(observation.get("agent"), "agent evidence")
    if require_run_id(agent_source.get("run_id"), "agent run ID") != run_id:
        fail(f"{expected['sample_id']}: agent run ID does not match browser run ID")
    vms_source = agent_source.get("vms")
    if not isinstance(vms_source, list):
        fail(f"{expected['sample_id']}: agent evidence has no VM events")
    agent = aggregate_agent_events(run_id, vms_source, expected["expected_vm_count"])
    readiness = require_object(observation.get("readiness"), "observation readiness")
    host_security = require_object(readiness.get("host_security"), "readiness host security")
    if host_security.get("phase") != HOST_SECURITY_PHASE:
        fail(f"{expected['sample_id']}: readiness is not the host security seal")
    if require_int(host_security.get("slowest_vm_ms"), "readiness host security ms") != slowest_agent_phase(
        agent, HOST_SECURITY_PHASE
    ):
        fail(f"{expected['sample_id']}: readiness host security time does not match the agent events")
    recorded_pty = require_object(readiness.get("recorded_pty"), "readiness recorded PTY")
    if recorded_pty.get("nonce_sha256") != browser["firstCommand"]["nonceSha256"]:
        fail(f"{expected['sample_id']}: readiness nonce does not match the recorded PTY output")
    if require_int(recorded_pty.get("output_unix_ms"), "readiness PTY output time") != browser[
        "firstCommand"
    ]["successUnixMs"]:
        fail(f"{expected['sample_id']}: readiness PTY output time does not match the browser evidence")
    if readiness.get("basis") != ["host-security-seal", "recorded-pty-output"]:
        fail(
            f"{expected['sample_id']}: readiness is not the host security seal"
            " and recorded PTY output"
        )
    workload = require_object(observation.get("workload"), "observation workload")
    if workload.get("foreground_id") != plan["foreground_workload"]["workload_id"]:
        fail(f"{expected['sample_id']}: workload is not the planned foreground workload")
    if expected["background_workload"] is not None:
        declared = require_object(
            require_object(plan.get("background_workloads"), "plan background workloads").get(
                expected["background_workload"]
            ),
            f"plan background workload {expected['background_workload']}",
        )
        if workload.get("background_id") != declared.get("workload_id"):
            fail(f"{expected['sample_id']}: background workload ID does not match the plan")
        if workload.get("background_rate_per_min") != declared.get("rate_per_min"):
            fail(f"{expected['sample_id']}: background workload rate does not match the plan")
        window = require_object(declared.get("window"), "plan background workload window")
        window_start = require_int(window.get("start_unix_ms"), "plan workload window start", 1)
        window_end = require_int(window.get("end_unix_ms"), "plan workload window end", 1)
        sample_start = require_int(workload.get("sample_start_unix_ms"), "workload sample start")
        sample_end = require_int(workload.get("sample_end_unix_ms"), "workload sample end")
        if sample_start < window_start or sample_end > window_end:
            fail(f"{expected['sample_id']}: sample is outside the declared background workload window")
        if sample_start != browser["startUnixMs"] or sample_end != browser["firstCommand"]["successUnixMs"]:
            fail(f"{expected['sample_id']}: workload sample window does not match the browser evidence")
        # Recompute the overlap from the recorded intervals. A hand-edited
        # label cannot pass this, and a combined condition needs every one of
        # its workloads, including the archive half.
        required = OBSERVABLE_WORKLOADS[expected["background_workload"]]
        if tuple(workload.get("required_workloads") or ()) != required:
            fail(
                f"{expected['sample_id']}: workload proof does not require "
                + ", ".join(required)
            )
        evidence = require_object(workload.get("evidence"), "workload evidence")
        for workload_key in required:
            item = require_object(evidence.get(workload_key), f"workload evidence {workload_key}")
            interval = {
                "start_unix_ms": require_int(
                    item.get("start_unix_ms"), f"workload {workload_key} interval start", 1
                ),
                "end_unix_ms": (
                    None
                    if item.get("end_unix_ms") is None
                    else require_int(
                        item.get("end_unix_ms"), f"workload {workload_key} interval end", 1
                    )
                ),
            }
            if not interval_covers_window(interval, (sample_start, sample_end)):
                fail(
                    f"{expected['sample_id']}: the {workload_key} workload interval"
                    " does not cover the sample window"
                )
    elif "background_id" in workload:
        fail(f"{expected['sample_id']}: workload has an unexpected background workload")
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
    teardown_failures = [
        item["sample_id"] for item in observed if item.get("teardown") == "failed"
    ]
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
        "teardown_failure_count": len(teardown_failures),
        "teardown_failure_samples": teardown_failures,
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


def condition_outliers(plan: dict[str, Any], observed: list[dict[str, Any]]) -> dict[str, Any]:
    """Record the slowest samples of every condition and every sample over target."""

    outliers: dict[str, Any] = {}
    for condition in plan["conditions"]:
        entries: list[dict[str, Any]] = []
        for record in observed:
            if record["condition"] != condition or record["status"] != "success":
                continue
            browser = record["browser"]
            entries.append(
                {
                    "sample_id": record["sample_id"],
                    "implementation": record["implementation"],
                    "scenario_id": record["scenario_id"],
                    "terminal_first_command_ms": browser["firstCommand"]["successUnixMs"]
                    - browser["startUnixMs"],
                }
            )
        entries.sort(key=lambda entry: (-entry["terminal_first_command_ms"], entry["sample_id"]))
        over_target = [
            entry for entry in entries if entry["terminal_first_command_ms"] > P95_TARGET_MS
        ]
        outliers[condition] = {
            "success_count": len(entries),
            "max_ms": entries[0]["terminal_first_command_ms"] if entries else None,
            "over_p95_target_count": len(over_target),
            "samples_over_p95_target": over_target[:20],
            "slowest_samples": entries[:20],
        }
    return outliers


def acceptance_report(
    plan: dict[str, Any],
    groups: dict[tuple[str, str, str], dict[str, Any]],
    missing: list[str],
    observed_count: int,
) -> dict[str, Any]:
    """Apply the release gate to the candidate against the measured baseline.

    The targets belong to the candidate only.  The baseline is the old
    release; it is expected to be slow and it may fail, and that must not
    decide the gate.  The baseline still has to be complete and its failures
    stay in the report, because it is the comparison value.

    The gate needs every planned sample of the campaign, no candidate
    failure, a candidate p50 and p95 inside the targets, and no new candidate
    failure against the baseline of the same scenario and condition.
    """

    targets = require_object(plan.get("targets"), "plan targets")
    p50_target = require_int(targets.get("p50_ms"), "plan p50 target", 1)
    p95_target = require_int(targets.get("p95_ms"), "plan p95 target", 1)
    samples_per_cell = require_int(plan.get("samples_per_implementation"), "plan samples", 1)
    cells: list[dict[str, Any]] = []
    reasons: list[str] = []
    if plan.get("plan_role") == "smoke":
        reasons.append(
            "this plan is a smoke plan: it can pass a functional check, but it never"
            " produces an acceptance result for a release decision"
        )
    for (scenario_id, condition, implementation), group in sorted(groups.items()):
        cell_reasons: list[str] = []
        cell = f"{scenario_id}/{condition}/{implementation}"
        expected = group["expected_count"]
        metric = group["metrics_ms"]["terminal_first_command_ms"]
        if expected != samples_per_cell:
            cell_reasons.append(f"cell plans {expected} samples, not {samples_per_cell}")
        if group["observed_count"] != expected:
            cell_reasons.append(f"{expected - group['observed_count']} planned samples are missing")
        teardown_failures = require_int(
            group.get("teardown_failure_count", 0), f"{cell} teardown failure count"
        )
        if teardown_failures > 0:
            cell_reasons.append(
                f"{teardown_failures} samples did not finish teardown;"
                " a leaked run invalidates the campaign"
            )
        if implementation == "candidate":
            if metric["count"] != expected:
                cell_reasons.append(
                    f"p50 and p95 use {metric['count']} of {expected} planned samples"
                )
            if group["failure_count"] > 0:
                cell_reasons.append(
                    f"{group['failure_count']} candidate failures; the gate allows none"
                )
            if metric["median"] is None or metric["median"] > p50_target:
                cell_reasons.append(f"candidate p50 {metric['median']} ms is above {p50_target} ms")
            if metric["p95"] is None or metric["p95"] > p95_target:
                cell_reasons.append(f"candidate p95 {metric['p95']} ms is above {p95_target} ms")
        passed = not cell_reasons
        if not passed:
            reasons.append(f"{cell}: " + "; ".join(cell_reasons))
        cells.append(
            {
                "scenario_id": scenario_id,
                "condition": condition,
                "implementation": implementation,
                "expected_count": expected,
                "success_count": group["success_count"],
                "failure_count": group["failure_count"],
                "teardown_failure_count": group.get("teardown_failure_count", 0),
                "teardown_failure_samples": group.get("teardown_failure_samples", []),
                "p50_ms": metric["median"],
                "p95_ms": metric["p95"],
                "gated": implementation == "candidate",
                "pass": passed,
                "reasons": cell_reasons,
            }
        )
    failure_parity: list[dict[str, Any]] = []
    new_failures: list[dict[str, Any]] = []
    baseline_failures: list[dict[str, Any]] = []
    for scenario_id, condition in sorted({(key[0], key[1]) for key in groups}):
        baseline = groups[(scenario_id, condition, "baseline")]
        candidate = groups[(scenario_id, condition, "candidate")]
        passed = candidate["failure_count"] <= baseline["failure_count"]
        entry = {
            "scenario_id": scenario_id,
            "condition": condition,
            "baseline_failures": baseline["failure_count"],
            "candidate_failures": candidate["failure_count"],
            "candidate_failure_codes": candidate["failure_codes"],
            "pass": passed,
        }
        failure_parity.append(entry)
        if baseline["failure_count"] > 0:
            baseline_failures.append(
                {
                    "scenario_id": scenario_id,
                    "condition": condition,
                    "baseline_failure_codes": baseline["failure_codes"],
                    "note": "the old release failed these samples; the gate records them and does not gate on them",
                }
            )
        if not passed:
            new_failures.append(entry)
            reasons.append(
                f"{scenario_id}/{condition}: candidate has {candidate['failure_count']} failures "
                f"against {baseline['failure_count']} baseline failures"
            )
    leaked: list[dict[str, Any]] = []
    for (scenario_id, condition, implementation), group in sorted(groups.items()):
        for sample_id in group.get("teardown_failure_samples", []):
            leaked.append(
                {
                    "sample_id": sample_id,
                    "scenario_id": scenario_id,
                    "condition": condition,
                    "implementation": implementation,
                }
            )
    if missing:
        reasons.append(f"{len(missing)} planned samples have no observation")
    return {
        "measured_sample_count": observed_count,
        "teardown_failure_count": len(leaked),
        "teardown_failure_samples": leaked,
        "pass": not reasons,
        "targets": {
            "p50_ms": p50_target,
            "p95_ms": p95_target,
            "samples_per_cell": samples_per_cell,
            "gated_implementations": ["candidate"],
            "max_candidate_failures_per_cell": 0,
        },
        "reasons": reasons,
        "cells": cells,
        "failure_parity": failure_parity,
        "baseline_failures": baseline_failures,
        "new_failures": new_failures,
    }


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
    acceptance = acceptance_report(plan, groups, missing, len(actual))
    return {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan["plan_id"],
        "plan_sha256": plan["plan_sha256"],
        "run_id": plan["run_id"],
        "run_manifest_sha256": plan["run_manifest_sha256"],
        "host_isolation_id": plan["host"]["isolation_id"],
        "measurement": {
            "host_attested": True,
            "host_attestation_sha256": plan["host_attestation"]["sha256"],
            "host_hostname": plan["host_attestation"]["hostname"],
            "host_hardware": plan["host_attestation"]["hardware"],
            "host_active_vms": plan["host_attestation"]["active_vms"],
            "client_region": plan["client"]["region"],
            "limits": MEASUREMENT_LIMITS,
        },
        "host_isolation_basis": "operator declaration; this tool cannot read the host controller",
        "generated_unix_ms": now_unix_ms(),
        "complete": not missing,
        "missing_sample_count": len(missing),
        "missing_sample_ids": missing,
        "primary_metric": plan["primary_metric"],
        "percentile_method": plan["percentile_method"],
        "targets": plan["targets"],
        "client": plan["client"],
        "releases": plan["releases"],
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
        "outliers": condition_outliers(plan, list(actual.values())),
        "acceptance": acceptance,
        "notes": [
            "Conditions are reported independently and are never pooled.",
            "The p50 and p95 targets belong to the candidate. The baseline is the old release and is not gated on performance.",
            "The baseline still needs every planned sample, and its failures stay in the report as the comparison value.",
            "A candidate cell with a failure cannot pass, and the candidate must not add a failure against its baseline.",
            "Readiness is the host security seal plus recorded PTY output. A connected WebSocket is not readiness.",
            "The gate passes only on measured samples. An incomplete campaign reports pass false.",
        ],
    }


def dry_run(args: argparse.Namespace) -> dict[str, Any]:
    """Check one run manifest, and one plan, without a host or a network call.

    The validation fails closed.  A production host, a missing controller
    lease, a client without an observed RTT range, a candidate whose images do
    not pin the current Kino ABI, release evidence that does not cover the
    seven components, or a plan that does not match the run manifest stop the
    campaign before the first sample.
    """

    manifest, manifest_sha256 = load_run_manifest(Path(args.run_manifest))
    host = manifest["host"]
    client = manifest["client"]
    observed_rtt = client["observed_rtt_ms"]
    checks = [
        (
            "client",
            f"{client['region']} client, observed RTT"
            f" {observed_rtt['min_ms']}..{observed_rtt['max_ms']} ms",
        ),
    ]
    for implementation in IMPLEMENTATIONS:
        release = manifest["releases"][implementation]
        checks.append(
            (
                f"release-{implementation}",
                f"{release['id']} evidence {release['evidence_sha256']} covers "
                + ", ".join(
                    f"{component}={release['components'][component]['id']}"
                    for component in RELEASE_COMPONENTS
                )
        + f", images Kino ABI {release['images_kino_abi']}",
            )
        )
    for key in BACKGROUND_WORKLOAD_KEYS:
        workload = manifest["background_workloads"][key]
        checks.append(
            (
                f"background-workload-{key}",
                f"{workload['workload_id']} at {workload['rate_per_min']} per minute"
                f" between {workload['window']['start_unix_ms']} and {workload['window']['end_unix_ms']}",
            )
        )
    planned_samples = (
        len(DEFAULT_CONDITIONS) * len(manifest["scenarios"]) * len(IMPLEMENTATIONS)
        * SAMPLES_PER_IMPLEMENTATION
    )
    cells: list[dict[str, Any]] = []
    plan_id: str | None = None
    plan_samples: int | None = None
    if args.plan:
        plan = load_plan(Path(args.plan))
        if plan["run_manifest_sha256"] != manifest_sha256:
            fail("dry run failed: the plan was built from a different run manifest")
        if plan["run_id"] != manifest["run_id"]:
            fail("dry run failed: the plan run ID does not match the run manifest")
        plan_id = plan["plan_id"]
        plan_samples = len(plan["schedule"])
        counts: dict[tuple[str, str], int] = {}
        for item in plan["schedule"]:
            key = (item["scenario_id"], item["condition"])
            counts[key] = counts.get(key, 0) + 1
        for (scenario_id, condition), count in sorted(counts.items()):
            cells.append(
                {
                    "scenario_id": scenario_id,
                    "condition": condition,
                    "samples": count,
                    "expected_samples": 2 * SAMPLES_PER_IMPLEMENTATION,
                }
            )
        if plan_samples != planned_samples:
            fail(f"dry run failed: the plan has {plan_samples} samples, not {planned_samples}")
        if any(cell["samples"] != cell["expected_samples"] for cell in cells):
            fail("dry run failed: a plan cell does not have the planned sample count")
        checks.append(
            ("plan", f"plan {plan_id} has {plan_samples} samples in {len(cells)} cells")
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": DRY_RUN_KIND,
        "run_id": manifest["run_id"],
        "run_manifest_sha256": manifest_sha256,
        "checked_unix_ms": now_unix_ms(),
        "network_actions": "none",
        "plan_id": plan_id,
        "plan_samples": plan_samples,
        "planned_samples": planned_samples,
        "host": manifest["host"],
        "client": manifest["client"],
        "foreground_workload": manifest["foreground_workload"],
        "background_workloads": manifest["background_workloads"],
        "scenarios": manifest["scenarios"],
        "participants": manifest["participants"],
        "releases": {
            implementation: {
                "id": manifest["releases"][implementation]["id"],
                "evidence_sha256": manifest["releases"][implementation]["evidence_sha256"],
                "images_kino_abi": manifest["releases"][implementation]["images_kino_abi"],
                "components": manifest["releases"][implementation]["components"],
            }
            for implementation in IMPLEMENTATIONS
        },
        "targets": {
            "p50_ms": P50_TARGET_MS,
            "p95_ms": P95_TARGET_MS,
            "samples_per_cell": SAMPLES_PER_IMPLEMENTATION,
            "conditions": list(DEFAULT_CONDITIONS),
        },
        "cells": cells,
        "checks": [{"check": name, "detail": detail} for name, detail in checks],
        "claim_ceiling": CLAIM_CEILINGS[manifest["host"]["role"]],
        "claims": [
            {
                "claim": "isolated-host",
                "detail": f"isolation {host['isolation_id']} as {host['role']},"
                f" serves_learners={host['serves_learners']},"
                f" hardware class {host['hardware_class']},"
                f" cpu class {host['cpu_class']}, region {host['region']}",
                "basis": "operator declaration; this tool cannot read the host controller",
            },
            {
                "claim": "controller-lease",
                "detail": f"controller {host['controller']} lease {host['controller_lease_id']}"
                f" and foreground workload {manifest['foreground_workload']['workload_id']}",
                "basis": "operator declaration; proven only by a running sample",
            },
            *[
                {
                    "claim": f"release-{implementation}-images",
                    "detail": f"{manifest['releases'][implementation]['id']} images"
                    f" Kino ABI {manifest['releases'][implementation]['images_kino_abi']}",
                    "basis": "measured by validate-release-bundle",
                }
                for implementation in IMPLEMENTATIONS
            ],
        ],
        "pass": True,
    }


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    plan = subcommands.add_parser("plan", help="write a deterministic benchmark schedule")
    plan.add_argument("--run-manifest", required=True)
    plan.add_argument("--plan-id", required=True)
    plan.add_argument("--output", required=True)
    plan.add_argument("--samples-per-implementation", type=int, default=SAMPLES_PER_IMPLEMENTATION)
    plan.add_argument("--block-size", type=int, default=BLOCK_SIZE)
    plan.add_argument(
        "--condition",
        action="append",
        choices=tuple(CONDITIONS),
        help="restrict the plan to these conditions; the default is every condition",
    )
    plan.add_argument(
        "--plan-role",
        choices=PLAN_ROLES,
        default="full",
        help="a smoke plan never produces an acceptance result",
    )

    dry = subcommands.add_parser(
        "dry-run", help="check the run manifest and plan without a host change"
    )
    dry.add_argument("--run-manifest", required=True)
    dry.add_argument("--plan")
    dry.add_argument("--output", required=True, help="path or - for stdout")

    bundle = subcommands.add_parser(
        "validate-release-bundle",
        help="measure a downloaded release bundle and write its evidence",
    )
    bundle.add_argument("--bundle", required=True, help="downloaded release bundle directory")
    bundle.add_argument("--manifest", required=True, help="bundle manifest file")
    bundle.add_argument("--release-id", required=True)
    bundle.add_argument("--output", required=True, help="path or - for stdout")

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
    record.add_argument(
        "--client-rtt-ms",
        type=int,
        help="measured client round trip time; required for a success record",
    )
    record.add_argument("--output", required=True)
    record.add_argument("--status", required=True, choices=("success", "failure"))
    record.add_argument("--run-id")
    record.add_argument("--browser-evidence")
    record.add_argument("--agent-events")
    record.add_argument("--host-delta")
    record.add_argument("--cache-refresh-id", help="background workload ID for the sample")
    record.add_argument(
        "--workload-events", help="host workload events for a background workload condition"
    )
    record.add_argument("--failure-code")
    record.add_argument(
        "--teardown",
        choices=TEARDOWN_STATES,
        help="the teardown outcome of the run, recorded and gated",
    )

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
            manifest, manifest_sha256 = load_run_manifest(Path(args.run_manifest))
            write_json(
                Path(args.output),
                create_plan(
                    manifest,
                    manifest_sha256,
                    args.plan_id,
                    args.samples_per_implementation,
                    args.block_size,
                    tuple(args.condition or DEFAULT_CONDITIONS),
                    args.plan_role,
                ),
            )
        elif args.command == "dry-run":
            write_json(output_path(args.output), dry_run(args))
        elif args.command == "validate-release-bundle":
            write_json(output_path(args.output), validate_release_bundle(args))
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
