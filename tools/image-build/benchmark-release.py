#!/usr/bin/env python3
"""Prepare, observe, and compare complete candidate image-build benchmarks.

The workflow owns release download and bundle upload. This helper only copies
course source, makes bounded benchmark-only HCL changes, observes the fixed
registry status endpoint, and writes JSON evidence.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import html
import json
import os
import re
import shutil
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


RECORD_SCHEMA_VERSION = 1
REGISTRY_ORIGIN = "https://intar.dev"
TARGET_SCENARIO_RELATIVE_PATH = Path(
    "klustered/klustered-04-repair-workload-chain/scenario.hcl"
)
TARGET_SCENARIO_ID = "klustered-04-repair-workload-chain"
TARGET_VM_NAME = "control-plane"
TARGET_FIRST_PROBE = "k3s-running"
TARGET_FIRST_PROBE_DESCRIPTION = "The k3s control plane should be running"
VARIANTS = ("unchanged", "runtime", "late-step")
IMPLEMENTATIONS = ("baseline", "candidate")
SAMPLE_MODES = ("warm", "no-cache-prepared")
# `image-cli/v0.4.3` is the released v11 reference at the start of this work.
# It is benchmark input only; no runtime path selects the old builder.
BASELINE_V11_CLI_VERSION = "0.4.3"
SAFE_REVISION = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
SAFE_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
EVENT_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
BENCHMARK_USER_AGENT = "Intar-Image-Benchmark/1"
MAX_HTTP_ERROR_BODY_BYTES = 4096
MAX_HTTP_DIAGNOSTIC_CHARS = 200


class BenchmarkError(RuntimeError):
    """A controlled benchmark failure that is safe to show in CI logs."""


def now_event(name: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "name": name,
        "at_unix_ms": time.time_ns() // 1_000_000,
        "at_rfc3339": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }


def fail(message: str) -> None:
    raise BenchmarkError(message)


def require_match(pattern: re.Pattern[str], value: str, name: str) -> str:
    if not pattern.fullmatch(value):
        fail(f"{name} has an invalid format")
    return value


def require_revision(value: str) -> str:
    return require_match(SAFE_REVISION, value, "revision")


def require_label(value: str, name: str) -> str:
    return require_match(SAFE_LABEL, value, name)


def require_sha256(value: str, name: str) -> str:
    return require_match(SHA256, value, name)


def require_source_sha(value: str) -> str:
    return require_match(SOURCE_SHA, value, "source SHA")


def require_semver(value: str) -> str:
    return require_match(SEMVER, value, "CLI version")


def require_choice(value: str, values: tuple[str, ...], name: str) -> str:
    if value not in values:
        fail(f"{name} must be one of: {', '.join(values)}")
    return value


def require_iteration(value: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        fail("iteration must be an integer of at least 1")
    return int(value)


def read_text(path: Path) -> str:
    try:
        return path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"expected UTF-8 HCL at {path}")
        raise AssertionError from error


def write_text(path: Path, value: str) -> None:
    path.write_bytes(value.encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_files(root: Path) -> list[Path]:
    if not root.is_dir():
        fail(f"source directory does not exist: {root}")
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            fail(f"benchmark source cannot contain a symlink: {path}")
        if path.is_file():
            files.append(path)
    return files


def markdown_snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in regular_files(root)
        if path.suffix == ".md"
    }


def scenario_hcl_snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in regular_files(root)
        if path.name == "scenario.hcl"
    }


def snapshot_digest(snapshot: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for relative_path, file_digest in sorted(snapshot.items()):
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def ensure_copy_target(source_root: Path, destination_root: Path) -> None:
    source = source_root.resolve(strict=True)
    destination = destination_root.resolve(strict=False)
    if destination.exists():
        fail(f"benchmark destination already exists: {destination}")
    try:
        destination.relative_to(source)
    except ValueError:
        return
    fail("benchmark destination cannot be inside the source checkout")


def known_target_path(courses_root: Path) -> Path:
    target = courses_root / TARGET_SCENARIO_RELATIVE_PATH
    if not target.is_file():
        fail(f"benchmark target is missing: {TARGET_SCENARIO_RELATIVE_PATH}")
    return target


def validate_known_target(text: str) -> None:
    scenario_line = f'scenario "{TARGET_SCENARIO_ID}" {{'
    if text.count(scenario_line) != 1:
        fail("runtime benchmark target no longer has the expected scenario label")
    vm_lines = re.findall(r'^  vm "([^"]+)" \{$', text, flags=re.MULTILINE)
    if vm_lines != [TARGET_VM_NAME]:
        fail("runtime benchmark target must have exactly one control-plane VM")


def mutate_runtime_variant(path: Path, revision: str) -> None:
    text = read_text(path)
    validate_known_target(text)
    probes = list(re.finditer(r'^    probe "([^"]+)" \{$', text, flags=re.MULTILINE))
    if not probes or probes[0].group(1) != TARGET_FIRST_PROBE:
        fail("runtime benchmark target no longer has the expected first probe")
    next_probe = probes[1].start() if len(probes) > 1 else len(text)
    first_probe = text[probes[0].start() : next_probe]
    expected = f'      description = "{TARGET_FIRST_PROBE_DESCRIPTION}"'
    if first_probe.count(expected) != 1:
        fail("runtime benchmark target no longer has the expected probe description")
    replacement = f'{expected[:-1]} [benchmark {revision}]"'
    text = text[: probes[0].start()] + first_probe.replace(expected, replacement, 1) + text[next_probe:]
    write_text(path, text)


def mutate_late_step_variant(path: Path) -> None:
    text = read_text(path)
    validate_known_target(text)
    final_shape = re.compile(
        r"\n(?P<probes>    probes = \[[^\n]+\]\n)  \}\n\}\n\Z",
        re.DOTALL,
    )
    match = final_shape.search(text)
    if match is None:
        fail("late-step benchmark target no longer has the known final VM shape")
    if text.count('\n  vm "') != 1:
        fail("late-step benchmark target must have exactly one VM")
    insertion = (
        '    step "benchmark-late-noop" {\n'
        "      command {\n"
        "        cmd = <<-SHELL\n"
        "          true\n"
        "        SHELL\n"
        "      }\n"
        "    }\n\n"
    )
    write_text(path, text[: match.start("probes")] + insertion + text[match.start("probes") :])


def append_benchmark_comment(path: Path, revision: str) -> None:
    content = path.read_bytes()
    if not content.endswith(b"\n"):
        content += b"\n"
    comment = f"# intar-image-build-benchmark revision: {revision}\n".encode("utf-8")
    path.write_bytes(content + comment)


def build_context(args: argparse.Namespace) -> dict[str, Any]:
    implementation = require_choice(args.implementation, IMPLEMENTATIONS, "implementation")
    cli_version = require_semver(args.cli_version)
    if implementation == "baseline" and cli_version != BASELINE_V11_CLI_VERSION:
        fail(
            f"baseline samples must use the released v11 CLI {BASELINE_V11_CLI_VERSION}"
        )
    if implementation == "candidate" and cli_version == BASELINE_V11_CLI_VERSION:
        fail("candidate samples must use a released CLI newer than the v11 baseline")
    return {
        "revision": require_revision(args.revision),
        "source_sha": require_source_sha(args.source_sha),
        "workflow_sha": require_source_sha(args.workflow_sha),
        "harness_fingerprint": require_sha256(args.harness_fingerprint, "harness fingerprint"),
        "cli_version": cli_version,
        "implementation": implementation,
        "sample_mode": require_choice(args.sample_mode, SAMPLE_MODES, "sample mode"),
        "variant": require_choice(args.variant, VARIANTS, "variant"),
        "iteration": require_iteration(args.iteration),
        "build_label": require_label(args.build_label, "build label"),
        "builder_profile": require_label(args.builder_profile, "builder profile"),
        "operator_attested_builder_binary_sha256": require_sha256(
            args.expected_builder_binary_sha256, "expected builder binary SHA-256"
        ),
        "catalog_channel": "candidate",
        "cache_preparation": {
            "source": "operator-attested external preparation",
            "evidence_id": require_label(
                args.external_preparation_evidence_id, "external preparation evidence ID"
            ),
            "verified_by_harness": False,
        },
    }


def prepare_catalog(args: argparse.Namespace) -> dict[str, Any]:
    context = build_context(args)
    source_root = Path(args.source_root)
    destination_root = Path(args.destination_root)
    source_courses = source_root / "courses"
    ensure_copy_target(source_root, destination_root)
    source_markdown = markdown_snapshot(source_courses)
    source_scenario_hcl = scenario_hcl_snapshot(source_courses)
    if not source_markdown:
        fail("source catalog has no Markdown files")

    destination_root.mkdir(parents=True, exist_ok=False)
    destination_courses = destination_root / "courses"
    shutil.copytree(source_courses, destination_courses, copy_function=shutil.copy2)
    scenario_files = sorted(destination_courses.rglob("scenario.hcl"))
    if not scenario_files:
        fail("source catalog has no scenario.hcl files")

    target = known_target_path(destination_courses)
    if context["variant"] == "runtime":
        mutate_runtime_variant(target, context["revision"])
    elif context["variant"] == "late-step":
        mutate_late_step_variant(target)

    comment_targets = scenario_files if context["variant"] != "late-step" else [target]
    for scenario_file in comment_targets:
        append_benchmark_comment(scenario_file, context["revision"])

    destination_markdown = markdown_snapshot(destination_courses)
    if destination_markdown != source_markdown:
        fail("benchmark preparation changed Markdown bytes")
    unrelated_hcl_preserved = True
    if context["variant"] == "late-step":
        target_relative = target.relative_to(destination_courses).as_posix()
        destination_scenario_hcl = scenario_hcl_snapshot(destination_courses)
        unrelated_hcl_preserved = all(
            destination_scenario_hcl.get(relative_path) == digest
            for relative_path, digest in source_scenario_hcl.items()
            if relative_path != target_relative
        )
        if not unrelated_hcl_preserved:
            fail("late-step benchmark preparation changed an unrelated scenario HCL file")

    record = {
        "schema_version": RECORD_SCHEMA_VERSION,
        "status": "prepared",
        "context": context,
        "catalog": {
            "complete_candidate_image_count": len(scenario_files),
            "expected_rebuilt_image_count": len(comment_targets),
            "markdown_files": len(source_markdown),
            "markdown_tree_sha256": snapshot_digest(source_markdown),
            "markdown_preserved": True,
            "forced_registry_rebuild": {
                "method": "unique harmless HCL comment",
                "scope": "all scenarios" if len(comment_targets) == len(scenario_files) else "target scenario only",
                "mutated_scenario_hcl_files": len(comment_targets),
                "target": TARGET_SCENARIO_RELATIVE_PATH.as_posix()
                if len(comment_targets) == 1
                else None,
                "unrelated_scenario_hcl_preserved": unrelated_hcl_preserved,
            },
            "rebuild_count_semantics": (
                "The upload receipt queued count is the number of new or retried image build "
                "rows. The revision status build count remains the complete candidate catalog."
            ),
        },
        "events": [now_event("prepare_started"), now_event("prepared")],
        "observations": [],
        "metrics": {
            "timing_semantics": (
                "The registry endpoint exposes status snapshots, not queue, worker start, "
                "publish, or host-ready timestamps. All phase durations are client-observed "
                "bounds at the polling interval."
            )
        },
    }
    write_json(Path(args.record), record)
    return record


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temporary:
        json.dump(value, temporary, indent=2, sort_keys=True)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)


def load_record(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        fail(f"benchmark record is missing: {path}")
        raise AssertionError from error
    except json.JSONDecodeError as error:
        fail(f"benchmark record is not valid JSON: {path}")
        raise AssertionError from error
    if not isinstance(raw, dict) or raw.get("schema_version") != RECORD_SCHEMA_VERSION:
        fail("benchmark record has an unsupported schema")
    if not isinstance(raw.get("context"), dict) or not isinstance(raw.get("events"), list):
        fail("benchmark record is incomplete")
    return raw


def add_event(record: dict[str, Any], name: str) -> dict[str, Any]:
    if not EVENT_NAME.fullmatch(name):
        fail("event name has an invalid format")
    event = now_event(name)
    record["events"].append(event)
    return event


def event_time(record: dict[str, Any], name: str) -> int | None:
    for event in reversed(record["events"]):
        if event.get("name") == name and isinstance(event.get("at_unix_ms"), int):
            return event["at_unix_ms"]
    return None


def add_event_once(record: dict[str, Any], name: str) -> int:
    existing = event_time(record, name)
    if existing is not None:
        return existing
    return add_event(record, name)["at_unix_ms"]


def mark_record(args: argparse.Namespace) -> dict[str, Any]:
    record_path = Path(args.record)
    record = load_record(record_path)
    add_event(record, args.event)
    write_json(record_path, record)
    return record


def record_observer_provenance(args: argparse.Namespace) -> dict[str, Any]:
    record_path = Path(args.record)
    record = load_record(record_path)
    provenance = record.setdefault("observer_provenance", [])
    if not isinstance(provenance, list):
        fail("benchmark record has invalid observer provenance")
    workflow_sha = require_source_sha(args.workflow_sha)
    workflow_run_id = require_iteration(args.workflow_run_id)
    observed = now_event("observer_started")
    provenance.append(
        {
            "workflow_sha": workflow_sha,
            "workflow_run_id": workflow_run_id,
            "at_unix_ms": observed["at_unix_ms"],
            "at_rfc3339": observed["at_rfc3339"],
        }
    )
    record["events"].append(observed)
    write_json(record_path, record)
    return record


def record_bundle_acceptance(args: argparse.Namespace) -> dict[str, Any]:
    if args.queued < 0 or args.assigned < 0:
        fail("bundle receipt counts must be nonnegative")
    record_path = Path(args.record)
    record = load_record(record_path)
    catalog = record.get("catalog")
    if not isinstance(catalog, dict):
        fail("benchmark record has no catalog evidence")
    expected = catalog.get("expected_rebuilt_image_count")
    complete = catalog.get("complete_candidate_image_count")
    if not isinstance(expected, int) or not isinstance(complete, int):
        fail("benchmark record has invalid image counts")
    if args.queued != expected:
        fail(
            f"bundle queued {args.queued} image builds; expected {expected} for this variant"
        )
    if args.queued > complete:
        fail("bundle queued more image builds than the complete catalog contains")
    if event_time(record, "bundle_accepted") is not None:
        fail("bundle acceptance was already recorded")
    record["rebuild"] = {
        "queued_image_builds": args.queued,
        "assigned_image_builds_observed": args.assigned,
        "queue_count_source": "bundle upload receipt",
    }
    add_event(record, "bundle_accepted")
    write_json(record_path, record)
    return record


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Any,
        fp: Any,
        code: int,
        message: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def registry_request(revision: str, token: str) -> urllib.request.Request:
    require_revision(revision)
    url = f"{REGISTRY_ORIGIN}/registry/v1/builds/revisions/{revision}?tools=stable"
    return urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": BENCHMARK_USER_AGENT,
        },
        method="GET",
    )


def safe_http_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = re.sub(r"(?i)bearer\s+\S+", "Bearer [redacted]", value)
    value = " ".join("".join(character if character.isprintable() else " " for character in value).split())
    return value[:MAX_HTTP_DIAGNOSTIC_CHARS] or None


def http_error_message(error: urllib.error.HTTPError) -> str:
    headers = error.headers
    content_type = safe_http_text(headers.get("Content-Type") if headers else None)
    cf_ray = safe_http_text(headers.get("CF-Ray") if headers else None)
    try:
        body = error.read(MAX_HTTP_ERROR_BODY_BYTES).decode("utf-8", errors="replace")
    except OSError:
        body = ""
    diagnostic: str | None = None
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        value = None
    if isinstance(value, dict):
        diagnostic = safe_http_text(value.get("error") or value.get("title"))
    if diagnostic is None:
        title = re.search(r"<title(?:\s[^>]*)?>(.*?)</title>", body, re.IGNORECASE | re.DOTALL)
        diagnostic = safe_http_text(html.unescape(title.group(1))) if title else None
    details = [f"HTTP {error.code}"]
    if content_type:
        details.append(f"content_type={content_type}")
    if cf_ray:
        details.append(f"cf_ray={cf_ray}")
    if diagnostic:
        details.append(f"diagnostic={diagnostic}")
    return "registry status returned " + "; ".join(details)


def registry_status(revision: str) -> dict[str, Any]:
    token = os.environ.get("INTAR_IMAGE_PUBLISH_TOKEN", "")
    if not token:
        fail("INTAR_IMAGE_PUBLISH_TOKEN is required for registry status")
    request = registry_request(revision, token)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                fail(f"registry status returned HTTP {response.status}")
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        fail(http_error_message(error))
    except urllib.error.URLError:
        fail("registry status request failed")
    except json.JSONDecodeError:
        fail("registry status was not valid JSON")
    if not isinstance(value, dict):
        fail("registry status was not a JSON object")
    return value


def count_values(values: list[Any]) -> dict[str, int]:
    counted = collections.Counter(value for value in values if isinstance(value, str))
    return dict(sorted(counted.items()))


def summarize_status(value: dict[str, Any], expected_revision: str) -> dict[str, Any]:
    if value.get("revision") != expected_revision:
        fail("registry status revision did not match the requested revision")
    if value.get("tools_channel") != "stable":
        fail("registry status did not use stable guest tools")
    state = value.get("state")
    ok = value.get("ok")
    builds = value.get("builds")
    hosts = value.get("hosts")
    if (
        not isinstance(state, str)
        or not isinstance(ok, bool)
        or not isinstance(builds, list)
        or not isinstance(hosts, list)
    ):
        fail("registry status was missing builds or hosts")
    if state not in {"queued", "building", "warming", "ready", "failed"}:
        fail("registry status had an unsupported state")
    if not all(isinstance(build, dict) for build in builds) or not all(
        isinstance(host, dict) for host in hosts
    ):
        fail("registry status had an invalid build or host entry")
    build_statuses = [build.get("status") for build in builds]
    build_phases = [build.get("phase") for build in builds]
    updated = [build.get("updated_at_unix_ms") for build in builds]
    updated_times = [value for value in updated if isinstance(value, int)]
    all_builds_succeeded = bool(builds) and all(status == "succeeded" for status in build_statuses)
    all_hosts_ready = bool(hosts) and all(host.get("ready") is True for host in hosts)
    return {
        "ok": ok,
        "state": state,
        "build_count": len(builds),
        "host_count": len(hosts),
        "build_status_counts": count_values(build_statuses),
        "build_phase_counts": count_values(build_phases),
        "ready_host_count": sum(host.get("ready") is True for host in hosts),
        "all_builds_succeeded": all_builds_succeeded,
        "all_hosts_ready": all_hosts_ready,
        "build_updated_at_min_unix_ms": min(updated_times) if updated_times else None,
        "build_updated_at_max_unix_ms": max(updated_times) if updated_times else None,
        "failed_build_count": sum(status in {"failed", "stale"} for status in build_statuses),
    }


def milliseconds_after(start: int | None, end: int | None) -> int | None:
    if start is None or end is None:
        return None
    return max(0, end - start)


def update_metrics(record: dict[str, Any]) -> None:
    bundle_started = event_time(record, "bundle_started")
    accepted = event_time(record, "bundle_accepted")
    building = event_time(record, "first_state_building")
    warming = event_time(record, "first_state_warming")
    fetching_sources = event_time(record, "first_build_phase_fetching_sources")
    building_base = event_time(record, "first_build_phase_building_base")
    build_phase = event_time(record, "first_build_phase_building")
    publishing = event_time(record, "first_build_phase_publishing")
    all_builds = event_time(record, "first_all_builds_succeeded")
    hosts_ready = event_time(record, "first_all_hosts_ready")
    ready = event_time(record, "ready_observed")
    record["metrics"].update(
        {
            "bundle_generation_and_upload_ms": milliseconds_after(bundle_started, accepted),
            "bundle_start_to_all_build_and_host_warm_ms": milliseconds_after(
                bundle_started, ready
            ),
            "acceptance_to_building_observed_ms": milliseconds_after(accepted, building),
            "acceptance_to_all_builds_succeeded_observed_ms": milliseconds_after(
                accepted, all_builds
            ),
            "acceptance_to_host_warm_observed_ms": milliseconds_after(accepted, hosts_ready),
            "acceptance_to_all_build_and_host_warm_ms": milliseconds_after(accepted, ready),
            "queue_observed_until_building_ms": milliseconds_after(accepted, building),
            "queue_observed_until_fetching_sources_ms": milliseconds_after(
                accepted, fetching_sources
            ),
            "base_prepare_observed_until_building_base_ms": milliseconds_after(
                accepted, building_base
            ),
            "build_observed_until_publishing_ms": milliseconds_after(build_phase, publishing),
            "build_observed_until_all_succeeded_ms": milliseconds_after(building, all_builds),
            "publish_observed_by_build_success_ms": milliseconds_after(accepted, all_builds),
            "publish_observed_until_all_succeeded_ms": milliseconds_after(
                publishing, all_builds
            ),
            "host_warm_observed_after_build_success_ms": milliseconds_after(all_builds, hosts_ready),
            "warming_observed_until_ready_ms": milliseconds_after(warming, ready),
        }
    )


def status_is_ready(summary: dict[str, Any], expected_builds: int) -> bool:
    return (
        summary["ok"]
        and summary["state"] == "ready"
        and summary["build_count"] == expected_builds
        and summary["host_count"] > 0
        and summary["all_builds_succeeded"]
        and summary["all_hosts_ready"]
    )


def observe_status(record: dict[str, Any], summary: dict[str, Any]) -> None:
    observed = now_event("status_observed")
    observation = {**observed, **summary}
    record["observations"].append(observation)
    state = summary["state"]
    if state in {"queued", "building", "warming", "ready"}:
        add_event_once(record, f"first_state_{state}")
    for phase in summary["build_phase_counts"]:
        add_event_once(record, f"first_build_phase_{phase}")
    if summary["all_builds_succeeded"]:
        add_event_once(record, "first_all_builds_succeeded")
    if summary["all_hosts_ready"]:
        add_event_once(record, "first_all_hosts_ready")
    update_metrics(record)


def poll_record(args: argparse.Namespace) -> dict[str, Any]:
    record_path = Path(args.record)
    record = load_record(record_path)
    context = record["context"]
    revision = context.get("revision")
    catalog = record.get("catalog")
    rebuild = record.get("rebuild")
    expected_builds = catalog.get("complete_candidate_image_count") if isinstance(catalog, dict) else None
    expected_rebuilt = catalog.get("expected_rebuilt_image_count") if isinstance(catalog, dict) else None
    queued_rebuilds = rebuild.get("queued_image_builds") if isinstance(rebuild, dict) else None
    if (
        not isinstance(revision, str)
        or not isinstance(expected_builds, int)
        or expected_builds < 1
        or not isinstance(expected_rebuilt, int)
        or not isinstance(queued_rebuilds, int)
        or queued_rebuilds != expected_rebuilt
    ):
        fail("benchmark record has no complete scenario catalog")
    if args.timeout_seconds < 1 or args.timeout_seconds > 21_600:
        fail("poll timeout must be between 1 and 21600 seconds")
    if args.interval_seconds < 1 or args.interval_seconds > 300:
        fail("poll interval must be between 1 and 300 seconds")

    add_event_once(record, "status_poll_started")
    deadline = time.monotonic() + args.timeout_seconds
    try:
        while True:
            raw = registry_status(revision)
            summary = summarize_status(raw, revision)
            observe_status(record, summary)
            if summary["state"] == "failed" or summary["failed_build_count"]:
                record["status"] = "failed"
                add_event_once(record, "build_failed_observed")
                update_metrics(record)
                write_json(record_path, record)
                fail("registry reported a failed or stale image build")
            if summary["state"] == "ready" and not status_is_ready(summary, expected_builds):
                record["status"] = "failed"
                add_event_once(record, "incomplete_ready_observed")
                update_metrics(record)
                write_json(record_path, record)
                fail("registry reported ready without the complete catalog and host cache")
            if status_is_ready(summary, expected_builds):
                record["status"] = "ready"
                add_event_once(record, "ready_observed")
                record["result"] = {
                    "complete_candidate_image_count": summary["build_count"],
                    "rebuilt_image_count": queued_rebuilds,
                    "reused_image_count": expected_builds - queued_rebuilds,
                }
                update_metrics(record)
                write_json(record_path, record)
                return record
            write_json(record_path, record)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                record["status"] = "timed_out"
                add_event_once(record, "status_poll_timed_out")
                update_metrics(record)
                write_json(record_path, record)
                fail("registry did not reach complete build and host readiness before timeout")
            time.sleep(min(args.interval_seconds, remaining))
    except BenchmarkError:
        write_json(record_path, record)
        raise


def sample_from_record(
    record: dict[str, Any], implementation: str, sample_mode: str
) -> dict[str, Any]:
    observer_provenance = record.get("observer_provenance", [])
    if not isinstance(observer_provenance, list):
        fail("benchmark record has invalid observer provenance")
    if observer_provenance:
        fail("recovered observer records cannot satisfy the strict three-sample gate")
    context = record.get("context")
    if not isinstance(context, dict):
        fail("benchmark comparison record lacks context")
    if context.get("implementation") != implementation:
        fail(f"benchmark record is not a {implementation} sample")
    if context.get("sample_mode") != sample_mode:
        fail("benchmark records use different sample modes")
    cache_preparation = context.get("cache_preparation")
    if (
        not isinstance(cache_preparation, dict)
        or cache_preparation.get("source") != "operator-attested external preparation"
        or cache_preparation.get("verified_by_harness") is not False
        or not isinstance(cache_preparation.get("evidence_id"), str)
        or not SAFE_LABEL.fullmatch(cache_preparation["evidence_id"])
    ):
        fail("benchmark record has no external preparation evidence ID")
    cli_version = context.get("cli_version")
    if not isinstance(cli_version, str) or not SEMVER.fullmatch(cli_version):
        fail("benchmark record has an invalid CLI version")
    if implementation == "baseline" and cli_version != BASELINE_V11_CLI_VERSION:
        fail(
            f"baseline comparison samples must use v11 CLI {BASELINE_V11_CLI_VERSION}"
        )
    if implementation == "candidate" and cli_version == BASELINE_V11_CLI_VERSION:
        fail("candidate comparison samples must use a CLI newer than the v11 baseline")
    builder_profile = context.get("builder_profile")
    builder_sha = context.get("operator_attested_builder_binary_sha256")
    workflow_sha = context.get("workflow_sha")
    harness_fingerprint = context.get("harness_fingerprint")
    if (
        not isinstance(builder_profile, str)
        or not SAFE_LABEL.fullmatch(builder_profile)
        or not isinstance(builder_sha, str)
        or not SHA256.fullmatch(builder_sha)
        or not isinstance(workflow_sha, str)
        or not SOURCE_SHA.fullmatch(workflow_sha)
        or not isinstance(harness_fingerprint, str)
        or not SHA256.fullmatch(harness_fingerprint)
    ):
        fail("benchmark record has invalid builder or harness attestation")
    if record.get("status") != "ready":
        fail("benchmark record is not ready")
    catalog = record.get("catalog")
    rebuild = record.get("rebuild")
    result = record.get("result")
    if (
        not isinstance(catalog, dict)
        or not isinstance(catalog.get("complete_candidate_image_count"), int)
        or not isinstance(catalog.get("expected_rebuilt_image_count"), int)
        or not isinstance(rebuild, dict)
        or not isinstance(rebuild.get("queued_image_builds"), int)
        or not isinstance(result, dict)
    ):
        fail("benchmark record has no complete catalog evidence")
    complete_images = catalog["complete_candidate_image_count"]
    expected_rebuilt = catalog["expected_rebuilt_image_count"]
    queued_images = rebuild["queued_image_builds"]
    if complete_images < 1 or expected_rebuilt < 1 or expected_rebuilt > complete_images:
        fail("benchmark record has no technical scenarios")
    if queued_images != expected_rebuilt:
        fail("benchmark upload did not queue the expected number of rebuilds")
    if (
        result.get("complete_candidate_image_count") != complete_images
        or result.get("rebuilt_image_count") != queued_images
    ):
        fail("benchmark record did not prove full candidate catalog readiness")
    duration = record.get("metrics", {}).get("bundle_start_to_all_build_and_host_warm_ms")
    if not isinstance(duration, int) or duration < 1:
        fail("benchmark record has no complete bundle-to-ready duration")
    return {
        "revision": context.get("revision"),
        "iteration": context.get("iteration"),
        "duration_ms": duration,
        "complete_candidate_image_count": complete_images,
        "rebuilt_image_count": queued_images,
        "builder_profile": builder_profile,
        "operator_attested_builder_binary_sha256": builder_sha,
        "workflow_sha": workflow_sha,
        "harness_fingerprint": harness_fingerprint,
        "external_preparation_evidence_id": cache_preparation["evidence_id"],
    }


def load_samples(paths: list[str], implementation: str, sample_mode: str) -> list[dict[str, Any]]:
    if len(paths) != 3:
        fail(f"{implementation} comparison requires exactly three samples")
    records = [load_record(Path(path)) for path in paths]
    samples = [sample_from_record(record, implementation, sample_mode) for record in records]
    revisions = [sample["revision"] for sample in samples]
    if len(set(revisions)) != 3:
        fail(f"{implementation} comparison samples must have unique revisions")
    iterations = {sample["iteration"] for sample in samples}
    if iterations != {1, 2, 3}:
        fail(f"{implementation} comparison iterations must be exactly 1, 2, and 3")
    common_fields = (
        "source_sha",
        "variant",
        "sample_mode",
        "builder_profile",
        "operator_attested_builder_binary_sha256",
        "harness_fingerprint",
    )
    for field in common_fields:
        values = {
            record["context"].get(field) if field in {"source_sha", "variant", "sample_mode"}
            else sample[field]
            for record, sample in zip(records, samples)
        }
        if len(values) != 1:
            fail(f"{implementation} comparison samples do not share {field}")
    if len({sample["complete_candidate_image_count"] for sample in samples}) != 1:
        fail(f"{implementation} comparison samples do not use the same catalog size")
    if len({sample["rebuilt_image_count"] for sample in samples}) != 1:
        fail(f"{implementation} comparison samples do not rebuild the same image count")
    return samples


def compare_samples(
    baseline_paths: list[str], candidate_paths: list[str], sample_mode: str
) -> dict[str, Any]:
    require_choice(sample_mode, SAMPLE_MODES, "sample mode")
    baseline = load_samples(baseline_paths, "baseline", sample_mode)
    candidate = load_samples(candidate_paths, "candidate", sample_mode)
    baseline_durations = [sample["duration_ms"] for sample in baseline]
    candidate_durations = [sample["duration_ms"] for sample in candidate]
    baseline_median = statistics.median(baseline_durations)
    candidate_median = statistics.median(candidate_durations)
    baseline_record = load_record(Path(baseline_paths[0]))
    candidate_record = load_record(Path(candidate_paths[0]))
    source_sha = baseline_record["context"]["source_sha"]
    variant = baseline_record["context"]["variant"]
    candidate_source_sha = candidate_record["context"]["source_sha"]
    candidate_variant = candidate_record["context"]["variant"]
    complete_images = baseline[0]["complete_candidate_image_count"]
    rebuilt_images = baseline[0]["rebuilt_image_count"]
    if (source_sha, variant) != (candidate_source_sha, candidate_variant):
        fail("baseline and candidate samples do not use the same source and variant")
    if (
        complete_images != candidate[0]["complete_candidate_image_count"]
        or rebuilt_images != candidate[0]["rebuilt_image_count"]
    ):
        fail("baseline and candidate samples do not rebuild the same catalog scope")
    same_harness = baseline[0]["harness_fingerprint"] == candidate[0]["harness_fingerprint"]
    full_catalog_rebuild = rebuilt_images == complete_images
    if not full_catalog_rebuild:
        threshold = {
            "applies": False,
            "rule": "one-scenario edit timing is reported separately",
        }
        threshold_passed: bool | None = None
    elif sample_mode == "warm":
        maximum_candidate_median = baseline_median / 2
        threshold = {
            "applies": True,
            "rule": "candidate median must be at least 2x faster than baseline",
            "minimum_speedup": 2.0,
            "maximum_candidate_median_ms": maximum_candidate_median,
        }
        threshold_passed = candidate_median <= maximum_candidate_median
    else:
        maximum_candidate_median = baseline_median * 1.2
        threshold = {
            "applies": True,
            "rule": "candidate cold median must be no more than 1.2x baseline",
            "maximum_slowdown_multiplier": 1.2,
            "maximum_candidate_median_ms": maximum_candidate_median,
        }
        threshold_passed = candidate_median <= maximum_candidate_median
    passed = same_harness and threshold_passed is not False
    return {
        "schema_version": RECORD_SCHEMA_VERSION,
        "sample_mode": sample_mode,
        "source_sha": source_sha,
        "variant": variant,
        "complete_candidate_image_count": complete_images,
        "rebuilt_image_count": rebuilt_images,
        "baseline": {"samples": baseline, "median_ms": baseline_median},
        "candidate": {"samples": candidate, "median_ms": candidate_median},
        "candidate_speedup": baseline_median / candidate_median,
        "threshold": threshold,
        "threshold_passed": threshold_passed,
        "harness_comparison": {
            "baseline_fingerprint": baseline[0]["harness_fingerprint"],
            "candidate_fingerprint": candidate[0]["harness_fingerprint"],
            "classification": "same-harness" if same_harness else "cross-harness",
            "baseline_workflow_shas": [sample["workflow_sha"] for sample in baseline],
            "candidate_workflow_shas": [sample["workflow_sha"] for sample in candidate],
        },
        "cache_preparation": {
            "source": "operator-attested external preparation",
            "verified_by_harness": False,
            "baseline_evidence_ids": [
                sample["external_preparation_evidence_id"] for sample in baseline
            ],
            "candidate_evidence_ids": [
                sample["external_preparation_evidence_id"] for sample in candidate
            ],
        },
        "passed": passed,
    }


def compare_records(args: argparse.Namespace) -> dict[str, Any]:
    report = compare_samples(args.baseline, args.candidate, args.sample_mode)
    write_json(Path(args.output), report)
    return report


def render_summary(record: dict[str, Any]) -> str:
    context = record["context"]
    metrics = record.get("metrics", {})
    acceptance_duration = metrics.get("acceptance_to_all_build_and_host_warm_ms")
    complete_duration = metrics.get("bundle_start_to_all_build_and_host_warm_ms")
    acceptance_text = (
        f"{acceptance_duration} ms" if isinstance(acceptance_duration, int) else "not complete"
    )
    complete_text = f"{complete_duration} ms" if isinstance(complete_duration, int) else "not complete"
    catalog = record.get("catalog", {})
    rebuild = record.get("rebuild", {})
    cache_preparation = context.get("cache_preparation", {})
    cache_evidence = (
        cache_preparation.get("evidence_id", "missing")
        if isinstance(cache_preparation, dict)
        else "missing"
    )
    return "\n".join(
        [
            "### Image build benchmark",
            "",
            f"- Revision: `{context['revision']}`",
            f"- Sample: `{context['implementation']}` / `{context['sample_mode']}` / `{context['variant']}`",
            f"- Source: `{context['source_sha']}`",
            f"- Builder profile: `{context['builder_profile']}`",
            f"- Catalog channel: `{context['catalog_channel']}`",
            f"- Complete candidate images: `{catalog.get('complete_candidate_image_count', 'pending')}`",
            f"- Queued rebuild images: `{rebuild.get('queued_image_builds', 'pending')}`",
            f"- Cache preparation: operator-attested `{cache_evidence}`",
            f"- Result: `{record['status']}`",
            f"- Bundle start to complete build and host warm: `{complete_text}`",
            f"- Acceptance to complete build and host warm: `{acceptance_text}`",
            "- Timing values are client-observed at the registry polling interval.",
        ]
    )


def summary_record(args: argparse.Namespace) -> None:
    print(render_summary(load_record(Path(args.record))))


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare", help="copy and mutate a temporary catalog")
    prepare.add_argument("--source-root", required=True)
    prepare.add_argument("--destination-root", required=True)
    prepare.add_argument("--record", required=True)
    prepare.add_argument("--revision", required=True)
    prepare.add_argument("--source-sha", required=True)
    prepare.add_argument("--workflow-sha", required=True)
    prepare.add_argument("--harness-fingerprint", required=True)
    prepare.add_argument("--cli-version", required=True)
    prepare.add_argument("--implementation", required=True, choices=IMPLEMENTATIONS)
    prepare.add_argument("--sample-mode", required=True, choices=SAMPLE_MODES)
    prepare.add_argument("--variant", required=True, choices=VARIANTS)
    prepare.add_argument("--iteration", required=True)
    prepare.add_argument("--build-label", required=True)
    prepare.add_argument("--builder-profile", required=True)
    prepare.add_argument("--expected-builder-binary-sha256", required=True)
    prepare.add_argument("--external-preparation-evidence-id", required=True)

    mark = commands.add_parser("mark", help="append a client-side phase timestamp")
    mark.add_argument("--record", required=True)
    mark.add_argument("--event", required=True)

    observe = commands.add_parser("observe", help="record a poll-only observer without changing the sample")
    observe.add_argument("--record", required=True)
    observe.add_argument("--workflow-sha", required=True)
    observe.add_argument("--workflow-run-id", required=True)

    accept = commands.add_parser("accept", help="record the authenticated bundle upload receipt")
    accept.add_argument("--record", required=True)
    accept.add_argument("--queued", type=int, required=True)
    accept.add_argument("--assigned", type=int, required=True)

    poll = commands.add_parser("poll", help="poll the fixed stable-tools registry endpoint")
    poll.add_argument("--record", required=True)
    poll.add_argument("--timeout-seconds", type=int, required=True)
    poll.add_argument("--interval-seconds", type=int, required=True)

    compare = commands.add_parser("compare", help="compare exactly three baseline and candidate samples")
    compare.add_argument("--sample-mode", required=True, choices=SAMPLE_MODES)
    compare.add_argument("--baseline", action="append", required=True)
    compare.add_argument("--candidate", action="append", required=True)
    compare.add_argument("--output", required=True)

    summary = commands.add_parser("summary", help="render a safe Markdown summary from a JSON record")
    summary.add_argument("--record", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        if args.command == "prepare":
            record = prepare_catalog(args)
            print(json.dumps({"revision": record["context"]["revision"], "status": record["status"]}))
        elif args.command == "mark":
            mark_record(args)
        elif args.command == "observe":
            record_observer_provenance(args)
        elif args.command == "accept":
            record_bundle_acceptance(args)
        elif args.command == "poll":
            record = poll_record(args)
            print(json.dumps({"revision": record["context"]["revision"], "status": record["status"]}))
        elif args.command == "compare":
            report = compare_records(args)
            print(json.dumps({"passed": report["passed"], "candidate_speedup": report["candidate_speedup"]}))
            return 0 if report["passed"] else 1
        elif args.command == "summary":
            summary_record(args)
        else:
            fail("unsupported command")
    except BenchmarkError as error:
        print(f"benchmark-release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
