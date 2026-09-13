import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("vm-boot-benchmark.py")
SPEC = importlib.util.spec_from_file_location("vm_boot_benchmark", SCRIPT)
assert SPEC and SPEC.loader
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def phase_timings(offset=0):
    phases = {key: index + offset for index, key in enumerate(benchmark.AGENT_TIMING_KEYS)}
    host_keys = benchmark.AGENT_TIMING_KEYS[: benchmark.AGENT_TIMING_KEYS.index("total_ms")]
    phases["total_ms"] = sum(phases[key] for key in host_keys)
    return phases


def host_delta(vm_name="vm_1"):
    return {
        "schema_version": 2,
        "vm_count": 1,
        "vm_cgroups": {vm_name: "intar.slice/intar-vms.slice/intar-vm-test.service"},
        "elapsed_ms": 100,
        "host_pressure_elapsed_ms": 100,
        "host_pressure_us": {
            resource: {"some_total_us": 2, "full_total_us": 1}
            for resource in benchmark.PSI_RESOURCES
        },
        "vm_cgroup_cpu_observed_interval": {
            "usage_usec": 10,
            "nr_throttled": 1,
            "throttled_usec": 2,
        },
        "vm_cgroup_io_observed_interval": {"rbytes": 3, "wbytes": 4},
        "vm_cgroup_cpu_total_at_command": {
            "usage_usec": 12,
            "nr_throttled": 1,
            "throttled_usec": 2,
        },
        "vm_cgroup_io_total_at_command": {"rbytes": 6, "wbytes": 7},
    }


def browser_evidence(run_id, scenario_id, start, client_rtt_ms=24):
    return {
        "schemaVersion": 2,
        "runId": run_id,
        "scenarioId": scenario_id,
        "startBoundary": "learner-start-link-click",
        "startUnixMs": start,
        "terminalConnectedUnixMs": start + 20,
        "clientRttMs": client_rtt_ms,
        "firstCommand": {
            "startedUnixMs": start + 25,
            "successUnixMs": start + 30,
            "nonceSha256": "d" * 64,
            "outputObservedAfterCommand": True,
        },
        "stages": {
            "start-click": start,
            "terminal-connected": start + 20,
            "terminal-visible": start + 22,
        },
    }


def manifest_workload_id(sample):
    """The declared background workload ID of a planned sample."""

    workload = sample["background_workload"]
    return {
        "cache-refresh": "cache-refresh-77",
        "cache-refresh+archive": "cache-refresh-78",
    }[workload]


def write_release_evidence(root: Path, name: str, kino_abi: int = 2) -> Path:
    bundle = root / name
    components = {}
    for component in benchmark.RELEASE_COMPONENTS:
        file_name = f"{component}.bin"
        bundle.mkdir(parents=True, exist_ok=True)
        (bundle / file_name).write_bytes(f"{name}-{component}".encode("utf-8"))
        entry = {"id": f"{name}-{component}", "file": file_name}
        if component == "images":
            entry["kino_abi"] = kino_abi
        components[component] = entry
    manifest_path = bundle / "bundle.json"
    write_json(
        manifest_path,
        {
            "schema_version": 2,
            "kind": "intar-release-bundle",
            "release_id": name,
            "components": components,
        },
    )
    evidence = benchmark.validate_release_bundle(
        argparse.Namespace(
            bundle=str(bundle),
            manifest=str(manifest_path),
            release_id=name,
            output="-",
        )
    )
    evidence_path = root / f"{name}.evidence.json"
    write_json(evidence_path, evidence)
    return evidence_path


def write_host_attestation(
    root: Path,
    *,
    verified: bool = True,
    environment: str = "benchmark",
    active_vms: int = 0,
    isolation_id: str = "bench-eu-1",
    role: str = "drained-production",
    production: bool = True,
    serves_learners: bool = False,
    hardware_class: str = "ryzen-9-3900-128g-nvme",
) -> Path:
    """Write the host attestation the adapter would produce.

    The default is the approved production maintenance window: the production
    host, drained, measured before and after the change on the same server. The
    production flag states what the host is, so it is true here and the role and
    the flag must agree.
    """

    path = root / "host-attestation.json"
    write_json(
        path,
        {
            "schema_version": 2,
            "kind": benchmark.HOST_ATTESTATION_KIND,
            "verified": verified,
            "environment": environment,
            "hostname": "bench-eu-1.intar.test",
            "hardware": "AMD EPYC 9354, 24 vCPU, 96 GiB, local NVMe",
            "cpu_cores": 24,
            "memory_mib": 98304,
            "active_vms": active_vms,
            "controller": "intar-host-controller",
            "controller_lease_id": "lease-0123",
            "isolation_id": isolation_id,
            "role": role,
            "production": production,
            "serves_learners": serves_learners,
            "hardware_class": hardware_class,
            "cpu_class": "prod-24-vcpu",
            "region": "eu-west",
            "captured_unix_ms": 1_757_699_000_000,
            "basis": "root-provisioned /etc/intar-benchmark/attestation.json read over SSH",
        },
    )
    return path


def workload_event(
    unix_ms: int,
    workload: str = "cache-refresh",
    kind: str = "start",
    job: str = "job-1",
    message: str = "running image cache pass",
) -> dict:
    return {
        "unix_ms": unix_ms,
        "workload": workload,
        "kind": kind,
        "job": job,
        "source": "intar-agent",
        "message": message,
    }


def workload_events_document(start_unix_ms: int, count: int = 2) -> dict:
    """A cache-refresh interval that opens before the sample window.

    Background work parks while a boot is critical, so a boot window often
    contains no event of its own while the interval is plainly active.
    """

    events = [workload_event(start_unix_ms - 30_000)]
    events.extend(workload_event(start_unix_ms - 30_000 + index) for index in range(count))
    return {
        "schema_version": 2,
        "kind": benchmark.WORKLOAD_EVENTS_KIND,
        "host": "bench-eu-1.intar.test",
        "captured_unix_ms": start_unix_ms + 10_000,
        "events": events,
    }


def run_manifest(root: Path, baseline="baseline-release", candidate="candidate-release", **overrides):
    write_host_attestation(
        root,
        isolation_id=overrides.get("isolation_id", "bench-eu-1"),
        role=overrides.get("role", "drained-production"),
        production=overrides.get("production", True),
        serves_learners=overrides.get("serves_learners", False),
        hardware_class=overrides.get("hardware_class", "ryzen-9-3900-128g-nvme"),
    )
    manifest = {
        "schema_version": 2,
        "kind": "vm-boot-benchmark-run-manifest",
        "run_id": "fresh-boot-2026-09-13",
        "foreground_workload": {
            "workload_id": "fg-workload-1",
            "controller": "intar-host-controller",
            "controller_lease_id": "lease-0123",
        },
        "host": {
            "controller": "intar-host-controller",
            "controller_lease_id": "lease-0123",
            "isolation_id": "bench-eu-1",
            "role": overrides.get("role", "drained-production"),
            "production": overrides.get("production", True),
            "serves_learners": overrides.get("serves_learners", False),
            "hardware_class": overrides.get("hardware_class", "ryzen-9-3900-128g-nvme"),
            "cpu_class": "prod-24-vcpu",
            "region": "eu-west",
            "attestation_file": "host-attestation.json",
        },
        "comparability": {
            "reference_class": "ryzen-9-3900-128g-nvme",
            "measured_class": "ryzen-9-3900-128g-nvme",
            "matches_reference": True,
            "reason": (
                "approved maintenance window on the production host, drained:"
                " the same server measured before and after the change"
            ),
        },
        "client": {"region": "eu", "observed_rtt_ms": {"min_ms": 18, "max_ms": 42}},
        "participants": ["bench-a", "bench-b", "bench-c", "bench-d"],
        "scenarios": [
            {"id": "broken-nginx", "vm_count": 1},
            {"id": "fundamentals-target", "vm_count": 1},
            {"id": "klustered-target", "vm_count": 3},
        ],
        "releases": {
            "baseline": {"id": baseline, "evidence_file": f"{baseline}.evidence.json"},
            "candidate": {"id": candidate, "evidence_file": f"{candidate}.evidence.json"},
        },
        "background_workloads": {
            "cache-refresh": {
                "workload_id": "cache-refresh-77",
                "rate_per_min": 3,
                "window": {"start_unix_ms": 1_757_700_000_000, "end_unix_ms": 1_757_710_000_000},
            },
            "cache-refresh+archive": {
                "workload_id": "cache-refresh-78",
                "rate_per_min": 3,
                "window": {"start_unix_ms": 1_757_700_000_000, "end_unix_ms": 1_757_710_000_000},
            },
        },
        "randomization": {"seed": "fresh-boot-2026-09-13"},
    }
    # Only the keys this fixture understands may be overridden, so a typo or a
    # host field cannot silently land at the top level of the manifest.
    for key in ("run_id", "participants"):
        if key in overrides:
            manifest[key] = overrides[key]
    path = root / "run-manifest.json"
    write_json(path, manifest)
    return path


def load_manifest_and_plan(root: Path, manifest_path: Path):
    manifest, manifest_sha256 = benchmark.load_run_manifest(manifest_path)
    plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")
    plan_path = root / "plan.json"
    write_json(plan_path, plan)
    return manifest, plan, plan_path


class ReleaseBundleTest(unittest.TestCase):
    def test_bundle_evidence_records_measured_artifacts_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence_path = write_release_evidence(root, "candidate-release")
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            self.assertEqual(evidence["kind"], benchmark.RELEASE_EVIDENCE_KIND)
            self.assertEqual(evidence["network_actions"], "none")
            self.assertEqual(set(evidence["components"]), set(benchmark.RELEASE_COMPONENTS))
            measured = evidence["components"]["agent"]["sha256"]
            self.assertEqual(
                measured,
                __import__("hashlib").sha256(b"candidate-release-agent").hexdigest(),
            )
            self.assertEqual(evidence["components"]["images"]["kino_abi"], benchmark.KINO_ABI)

    def test_bundle_evidence_rejects_a_wrong_kino_abi(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "Kino ABI"):
                write_release_evidence(root, "baseline-release", kino_abi=3)

    def test_bundle_evidence_records_a_legacy_baseline_abi_without_a_flag(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence_path = write_release_evidence(
                root, "baseline-release", kino_abi=benchmark.LEGACY_KINO_ABI
            )
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            self.assertEqual(
                evidence["components"]["images"]["kino_abi"], benchmark.LEGACY_KINO_ABI
            )
            self.assertNotIn("allow_legacy_kino_abi", evidence)
            loaded = benchmark.load_release_evidence(evidence_path, "baseline-release")
            self.assertEqual(loaded["images_kino_abi"], benchmark.LEGACY_KINO_ABI)

    def test_bundle_evidence_refuses_an_unknown_abi(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence_path = write_release_evidence(root, "baseline-release")
            unknown = json.loads(evidence_path.read_text(encoding="utf-8"))
            unknown["components"]["images"]["kino_abi"] = 3
            write_json(evidence_path, unknown)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "Kino ABI"):
                benchmark.load_release_evidence(evidence_path, "baseline-release")

    def test_the_variant_decides_the_abi_and_no_operator_flag_can_move_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release", kino_abi=benchmark.LEGACY_KINO_ABI)
            write_release_evidence(root, "candidate-release")
            manifest, _ = benchmark.load_run_manifest(run_manifest(root))
            self.assertEqual(
                manifest["releases"]["baseline"]["images_kino_abi"],
                benchmark.LEGACY_KINO_ABI,
            )
            self.assertEqual(
                manifest["releases"]["candidate"]["images_kino_abi"], benchmark.KINO_ABI
            )

            legacy_candidate = json.loads(
                (root / "candidate-release.evidence.json").read_text(encoding="utf-8")
            )
            legacy_candidate["components"]["images"]["kino_abi"] = benchmark.LEGACY_KINO_ABI
            write_json(root / "candidate-release.evidence.json", legacy_candidate)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "candidate release images"):
                benchmark.load_run_manifest(run_manifest(root))

    def test_bundle_helper_refuses_a_missing_component_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            (root / "baseline-release" / "kernel.bin").unlink()
            with self.assertRaisesRegex(benchmark.BenchmarkError, "file is missing"):
                benchmark.validate_release_bundle(
                    argparse.Namespace(
                        bundle=str(root / "baseline-release"),
                        manifest=str(root / "baseline-release" / "bundle.json"),
                        release_id="baseline-release",
                        output="-",
                    )
                )


class PlanTest(unittest.TestCase):
    def test_plan_has_2400_samples_in_four_conditions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, plan, plan_path = load_manifest_and_plan(root, run_manifest(root))

            self.assertEqual(len(plan["schedule"]), 3 * 4 * 2 * 100)
            self.assertEqual(plan["conditions"], list(benchmark.DEFAULT_CONDITIONS))
            self.assertEqual(plan["targets"]["p50_ms"], benchmark.P50_TARGET_MS)
            self.assertEqual(plan["targets"]["p95_ms"], benchmark.P95_TARGET_MS)
            cells = {}
            for sample in plan["schedule"]:
                key = (sample["scenario_id"], sample["condition"], sample["implementation"])
                cells[key] = cells.get(key, 0) + 1
            self.assertEqual(len(cells), 3 * 4 * 2)
            self.assertEqual(set(cells.values()), {100})

            concurrent = {}
            for sample in plan["schedule"]:
                if sample["condition"] == "concurrent-4-prepared":
                    concurrent.setdefault(sample["launch_group"], []).append(sample)
            for group in concurrent.values():
                self.assertEqual(group[0]["launch_concurrency"], 4)
                self.assertEqual(len({sample["participant_id"] for sample in group}), 4)
            for sample in plan["schedule"]:
                if sample["condition"] == "serial-prepared":
                    self.assertIsNone(sample["background_workload"])
                if sample["condition"] == "serial-background-cache":
                    self.assertEqual(sample["background_workload"], "cache-refresh")
                if sample["condition"] == "concurrent-4-background-cache-archive":
                    self.assertEqual(sample["background_workload"], "cache-refresh+archive")
            benchmark.load_plan(plan_path)

    def test_plan_blocks_are_randomized_and_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest_path = run_manifest(root)
            _, first, plan_path = load_manifest_and_plan(root, manifest_path)
            manifest, manifest_sha256 = benchmark.load_run_manifest(manifest_path)
            second = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")

            self.assertEqual(
                benchmark.canonical_json(first["schedule"]),
                benchmark.canonical_json(second["schedule"]),
            )
            order = [
                (block["condition"], block["block_index"], block["scenario_id"])
                for block in first["randomization"]["block_order"]
            ]
            self.assertEqual(len(order), len(set(order)))
            self.assertNotEqual(order, sorted(order))
            groups = {}
            for sample in first["schedule"]:
                groups.setdefault(sample["launch_group"], set()).add(sample["implementation"])
            self.assertEqual(
                {frozenset(value) for value in groups.values()},
                {frozenset({"baseline"}), frozenset({"candidate"})},
            )

    def test_plan_requires_four_participants_and_an_older_plan_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            path = run_manifest(root, participants=["bench-a"])
            with self.assertRaisesRegex(benchmark.BenchmarkError, "distinct participants"):
                benchmark.load_run_manifest(path)

            manifest, plan, plan_path = load_manifest_and_plan(root, run_manifest(root))
            plan["schema_version"] = 1
            write_json(plan_path, plan)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "unsupported schema version"):
                benchmark.load_plan(plan_path)

    def test_plan_rejects_a_cell_with_the_wrong_sample_count(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            _, plan, plan_path = load_manifest_and_plan(root, run_manifest(root))
            plan["schedule"] = plan["schedule"][:-1]
            plan.pop("plan_sha256")
            plan["plan_sha256"] = __import__("hashlib").sha256(
                benchmark.canonical_json(plan)
            ).hexdigest()
            write_json(plan_path, plan)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "planned sample count"):
                benchmark.load_plan(plan_path)


class DryRunTest(unittest.TestCase):
    def test_dry_run_passes_for_the_production_window_and_refuses_bad_declarations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            path = run_manifest(root)
            _, _, plan_path = load_manifest_and_plan(root, path)
            report = benchmark.dry_run(
                argparse.Namespace(run_manifest=str(path), plan=str(plan_path), output="-")
            )
            self.assertTrue(report["pass"])
            self.assertEqual(report["network_actions"], "none")
            self.assertEqual(report["planned_samples"], 2400)
            self.assertEqual(report["plan_samples"], 2400)
            self.assertEqual(len(report["cells"]), 12)

            def rewrite(mutate):
                document = json.loads(path.read_text(encoding="utf-8"))
                mutate(document)
                write_json(path, document)

            def check(message):
                with self.assertRaisesRegex(benchmark.BenchmarkError, message):
                    benchmark.dry_run(
                        argparse.Namespace(run_manifest=str(path), plan=None, output="-")
                    )

            # The attestation must agree with the manifest on the role, on the
            # production flag, and on whether the host serves learners.
            rewrite(lambda document: document["host"].update(serves_learners=True))
            write_host_attestation(root, serves_learners=False)
            check("serves_learners does not match")
            write_host_attestation(root, serves_learners=True)
            # A production host may serve learners, so this state is valid.
            self.assertTrue(
                benchmark.dry_run(
                    argparse.Namespace(run_manifest=str(path), plan=None, output="-")
                )["pass"]
            )

            # A host that is not the drained production host may not claim to
            # serve learners.
            path = run_manifest(root, role="ci-runner", production=False, serves_learners=True)
            write_host_attestation(
                root, role="ci-runner", production=False, serves_learners=True
            )
            check("only a drained production host")

            # A lying production flag is refused in both directions.
            path = run_manifest(root)
            write_host_attestation(root, production=False)
            check("production False does not match")
            path = run_manifest(root, role="isolated-benchmark", production=True)
            write_host_attestation(root, role="isolated-benchmark", production=True)
            check("only the drained-production role")

            # The class the numbers came from must match the class claimed.
            path = run_manifest(root)
            rewrite(
                lambda document: document["comparability"].update(
                    measured_class="xeon-e5-1620-31g"
                )
            )
            check("claims a match")

            # A runner-class host is allowed and carries a lower ceiling, so a
            # smoke comparison can run without pretending to be release grade.
            runner = run_manifest(
                root,
                role="ci-runner",
                production=False,
                hardware_class="github-ubuntu-24.04-4vcpu",
            )
            runner_document = json.loads(runner.read_text(encoding="utf-8"))
            runner_document["comparability"] = {
                "reference_class": "ryzen-9-3900-128g-nvme",
                "measured_class": "github-ubuntu-24.04-4vcpu",
                "matches_reference": False,
                "reason": "CI runner class: functional proof and phase timings only",
            }
            write_json(runner, runner_document)
            write_host_attestation(
                root,
                role="ci-runner",
                production=False,
                hardware_class="github-ubuntu-24.04-4vcpu",
            )
            runner_report = benchmark.dry_run(
                argparse.Namespace(run_manifest=str(runner), plan=None, output="-")
            )
            self.assertTrue(runner_report["pass"])
            self.assertIn("functional proof", runner_report["claim_ceiling"])

    def test_dry_run_rejects_a_plan_from_another_run_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            path = run_manifest(root)
            _, _, plan_path = load_manifest_and_plan(root, path)
            other = run_manifest(root, run_id="another-run")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "different run manifest"):
                benchmark.dry_run(
                    argparse.Namespace(run_manifest=str(other), plan=str(plan_path), output="-")
                )


class HostCaptureTest(unittest.TestCase):
    def test_host_delta_rejects_counter_rollback_and_keeps_pressure_separate(self):
        before = {
            "schema_version": 2,
            "kind": "run-cgroup-snapshot",
            "captured_unix_ms": 100,
            "vm_cgroups": {
                "vm_1": {
                    "cgroup": "intar.slice/vm.service",
                    "cpu": {"usage_usec": 10, "nr_throttled": 1, "throttled_usec": 2},
                    "io": {"rbytes": 4},
                }
            },
        }
        after = {
            "schema_version": 2,
            "kind": "run-cgroup-snapshot",
            "captured_unix_ms": 150,
            "vm_cgroups": {
                "vm_1": {
                    "cgroup": "intar.slice/vm.service",
                    "cpu": {"usage_usec": 18, "nr_throttled": 2, "throttled_usec": 4},
                    "io": {"rbytes": 9},
                }
            },
        }
        delta = benchmark.host_snapshot_delta(before, after)
        self.assertEqual(delta["elapsed_ms"], 50)
        self.assertEqual(delta["vm_cgroup_cpu_observed_interval"]["throttled_usec"], 2)
        self.assertEqual(delta["vm_cgroup_cpu_total_at_command"]["usage_usec"], 18)

        after["vm_cgroups"]["vm_1"]["cpu"]["usage_usec"] = 9
        with self.assertRaisesRegex(benchmark.BenchmarkError, "decreased"):
            benchmark.host_snapshot_delta(before, after)

    def test_host_pressure_delta_can_start_before_the_vm_cgroup_exists(self):
        before = {
            "schema_version": 2,
            "kind": "host-pressure-snapshot",
            "captured_unix_ms": 10,
            "host_pressure_us": {
                resource: {"some_total_us": 2, "full_total_us": 1}
                for resource in benchmark.PSI_RESOURCES
            },
        }
        after = {
            "schema_version": 2,
            "kind": "host-pressure-snapshot",
            "captured_unix_ms": 50,
            "host_pressure_us": {
                resource: {"some_total_us": 7, "full_total_us": 3}
                for resource in benchmark.PSI_RESOURCES
            },
        }
        delta = benchmark.host_pressure_delta(before, after)
        self.assertEqual(delta["elapsed_ms"], 40)
        self.assertEqual(delta["host_pressure_us"]["io"]["some_total_us"], 5)


class AgentEvidenceTest(unittest.TestCase):
    def test_agent_log_extraction_requires_all_phase_fields_and_never_copies_log_text(self):
        fields = ["run_id=run_1", "vm=vm_1", "boot_timing_version=2"]
        fields.extend(f"{key}={value}" for key, value in phase_timings().items())
        event = benchmark.parse_agent_timing_line("INFO vm booted " + " ".join(fields))
        self.assertEqual(event["run_id"], "run_1")
        self.assertEqual(
            event["phase_ms"]["guest_kino_ms"], benchmark.AGENT_TIMING_KEYS.index("guest_kino_ms")
        )
        self.assertNotIn("INFO", json.dumps(event))

        colored = benchmark.parse_agent_timing_line(
            "\x1b[32mINFO\x1b[0m vm booted " + " ".join(fields)
        )
        self.assertEqual(colored, event)

        missing = "INFO vm booted run_id=run_1 vm=vm_1 boot_timing_version=2 queue_ms=1 image_cache_ms=1"
        with self.assertRaisesRegex(benchmark.BenchmarkError, "disk_stage_ms"):
            benchmark.parse_agent_timing_line(missing)

    def test_agent_timing_rejects_old_versions_and_inconsistent_totals(self):
        event = {"boot_timing_version": 2, "phase_ms": phase_timings()}
        self.assertEqual(benchmark.agent_phase_timings(event), phase_timings())
        for version in (None, 1, 3):
            with self.assertRaisesRegex(benchmark.BenchmarkError, "boot timing version"):
                benchmark.agent_phase_timings({**event, "boot_timing_version": version})
        with self.assertRaisesRegex(benchmark.BenchmarkError, "sum to total_ms"):
            benchmark.agent_phase_timings(
                {**event, "phase_ms": {**phase_timings(), "total_ms": 0}}
            )

    def test_multi_vm_agent_evidence_requires_each_planned_vm(self):
        events = [
            {
                "schema_version": 2,
                "run_id": "run_1",
                "vm": "control",
                "boot_timing_version": 2,
                "phase_ms": phase_timings(10),
            },
            {
                "schema_version": 2,
                "run_id": "run_1",
                "vm": "worker",
                "boot_timing_version": 2,
                "phase_ms": phase_timings(20),
            },
        ]
        aggregate = benchmark.aggregate_agent_events("run_1", events, 2)
        self.assertEqual(aggregate["vm_count"], 2)
        self.assertEqual(
            benchmark.slowest_agent_phase(aggregate, "total_ms"),
            phase_timings(20)["total_ms"],
        )
        with self.assertRaisesRegex(benchmark.BenchmarkError, "planned VM topology"):
            benchmark.aggregate_agent_events("run_1", events, 3)


class ReadinessTest(unittest.TestCase):
    def test_browser_evidence_requires_remote_output_after_the_nonce_command(self):
        evidence = browser_evidence("run_1", "broken-nginx", 1_000)
        evidence["firstCommand"]["outputObservedAfterCommand"] = False
        with self.assertRaisesRegex(benchmark.BenchmarkError, "output after the command"):
            benchmark.normalize_browser_evidence(evidence, "run_1", "broken-nginx", False)

    def test_browser_evidence_requires_a_measured_client_rtt(self):
        evidence = browser_evidence("run_1", "broken-nginx", 1_000)
        evidence.pop("clientRttMs")
        with self.assertRaisesRegex(benchmark.BenchmarkError, "client RTT"):
            benchmark.normalize_browser_evidence(evidence, "run_1", "broken-nginx", False)


class TerminalVisibleTest(unittest.TestCase):
    def test_a_hidden_terminal_that_answers_the_nonce_is_refused_for_a_candidate(self):
        # The socket returned the nonce, so the command succeeded, but the page
        # never showed a terminal the learner could use. A candidate sample must
        # not count.
        evidence = browser_evidence("run_1", "broken-nginx", 1_000)
        evidence["stages"].pop("terminal-visible")
        with self.assertRaisesRegex(benchmark.BenchmarkError, "terminal-visible"):
            benchmark.normalize_browser_evidence(evidence, "run_1", "broken-nginx", True)

    def test_the_baseline_release_may_omit_the_visible_mark(self):
        # The old release does not write the mark, so the baseline is accepted
        # without it and still measured from the Start click.
        evidence = browser_evidence("run_1", "broken-nginx", 1_000)
        evidence["stages"].pop("terminal-visible")
        normalized = benchmark.normalize_browser_evidence(
            evidence, "run_1", "broken-nginx", False
        )
        self.assertNotIn("terminal-visible", normalized["stages"])
        self.assertEqual(normalized["startUnixMs"], 1_000)
        self.assertEqual(normalized["firstCommand"]["successUnixMs"], 1_030)

    def test_the_visible_mark_must_be_after_the_connection_and_before_the_command(self):
        early = browser_evidence("run_1", "broken-nginx", 1_000)
        early["stages"]["terminal-visible"] = 1_010
        with self.assertRaisesRegex(benchmark.BenchmarkError, "before the terminal-connected"):
            benchmark.normalize_browser_evidence(early, "run_1", "broken-nginx", True)

        late = browser_evidence("run_1", "broken-nginx", 1_000)
        late["stages"]["terminal-visible"] = 1_026
        with self.assertRaisesRegex(benchmark.BenchmarkError, "after the first command"):
            benchmark.normalize_browser_evidence(late, "run_1", "broken-nginx", True)

        accepted = browser_evidence("run_1", "broken-nginx", 1_000)
        normalized = benchmark.normalize_browser_evidence(
            accepted, "run_1", "broken-nginx", True
        )
        self.assertEqual(normalized["stages"]["terminal-visible"], 1_022)

    def test_a_candidate_record_without_the_visible_mark_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = CampaignTest().campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = next(
                item for item in plan["schedule"] if item["implementation"] == "candidate"
            )
            index = plan["schedule"].index(sample)
            browser_path = root / f"browser-{index}.json"
            browser = json.loads(browser_path.read_text(encoding="utf-8"))
            browser["stages"].pop("terminal-visible")
            write_json(browser_path, browser)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "terminal-visible"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=sample["sample_id"],
                        participant_id=sample["participant_id"],
                        client_rtt_ms=24,
                        output=str(observations),
                        status="success",
                        run_id=f"run_{index}",
                        browser_evidence=str(browser_path),
                        agent_events=str(agent_events),
                        host_delta=str(delta_path),
                        cache_refresh_id=None,
                        workload_events=None,
                        teardown="destroyed",
                        failure_code=None,
                    )
                )


class CampaignTest(unittest.TestCase):
    def campaign(self, root: Path):
        write_release_evidence(root, "baseline-release")
        write_release_evidence(root, "candidate-release")
        manifest_path = run_manifest(root)
        manifest, manifest_sha256 = benchmark.load_run_manifest(manifest_path)
        plan = benchmark.create_plan(
            manifest, manifest_sha256, "fresh-boot-2026-09-13", 4, 4
        )
        plan_path = root / "plan.json"
        write_json(plan_path, plan)
        observations = root / "observations.ndjson"
        delta_path = root / "host-delta.json"
        write_json(delta_path, host_delta())
        agent_events = root / "agent-events.ndjson"
        events = []
        for index, sample in enumerate(plan["schedule"]):
            run_id = f"run_{index}"
            events.append(
                {
                    "schema_version": 2,
                    "run_id": run_id,
                    "vm": "vm_1",
                    "boot_timing_version": 2,
                    "phase_ms": phase_timings(index),
                }
            )
            browser_path = root / f"browser-{index}.json"
            browser = browser_evidence(
                run_id, sample["scenario_id"], 1_757_700_000_000 + index * 1_000
            )
            browser.update(
                {
                    "benchmarkRunId": sample["sample_id"],
                    "participantId": sample["participant_id"],
                    "variant": sample["implementation"],
                    "releaseId": sample["release"]["id"],
                    "releaseManifestSha256": sample["release"]["manifest_sha256"],
                }
            )
            write_json(browser_path, browser)
        agent_events.write_text(
            "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
        )
        return plan_path, observations, agent_events, delta_path

    def test_record_and_report_keep_failures_out_of_percentiles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            first = plan["schedule"][0]
            benchmark.record_sample(
                argparse.Namespace(
                    plan=str(plan_path),
                    sample_id=first["sample_id"],
                    participant_id=first["participant_id"],
                    client_rtt_ms=24,
                    output=str(observations),
                    status="failure",
                    run_id=None,
                    browser_evidence=None,
                    agent_events=None,
                    host_delta=None,
                    cache_refresh_id=None,
                    workload_events=None,
                    failure_code="launch_failed",
                    teardown="not-needed",
                )
            )
            second = plan["schedule"][1]
            benchmark.record_sample(
                argparse.Namespace(
                    plan=str(plan_path),
                    sample_id=second["sample_id"],
                    participant_id=second["participant_id"],
                    client_rtt_ms=24,
                    output=str(observations),
                    status="success",
                    run_id="run_1",
                    browser_evidence=str(root / "browser-1.json"),
                    agent_events=str(agent_events),
                    host_delta=str(delta_path),
                    workload_events=None,
                        cache_refresh_id=(
                        "cache-refresh-77" if second["background_workload"] else None
                    ),
                    failure_code=None,
                    teardown="destroyed",
                )
            )
            report = benchmark.build_report(
                argparse.Namespace(
                    plan=str(plan_path), observations=str(observations), allow_incomplete=True
                )
            )
            self.assertFalse(report["complete"])
            self.assertFalse(report["acceptance"]["pass"])
            cell = next(
                group
                for group in report["groups"]
                if group["implementation"] == first["implementation"]
                and group["scenario_id"] == first["scenario_id"]
                and group["condition"] == first["condition"]
            )
            self.assertEqual(cell["failure_count"], 1)
            self.assertIn("launch_failed", cell["failure_codes"])
            self.assertIn("serial-prepared", report["outliers"])

    def test_background_sample_needs_the_declared_workload_id_and_window(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = next(
                item
                for item in plan["schedule"]
                if item["background_workload"] == "cache-refresh"
                and item["scenario_id"] == "broken-nginx"
            )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "background workload"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=sample["sample_id"],
                        participant_id=sample["participant_id"],
                        client_rtt_ms=24,
                        output=str(observations),
                        status="failure",
                        run_id=None,
                        browser_evidence=None,
                        agent_events=None,
                        host_delta=None,
                        cache_refresh_id=None,
                        workload_events=None,
                        failure_code="launch_failed",
                        teardown="not-needed",
                    )
                )

            index = plan["schedule"].index(sample)
            browser_path = root / f"browser-{index}.json"
            browser = json.loads(browser_path.read_text(encoding="utf-8"))
            browser["startUnixMs"] = 1_757_000_000_000
            browser["terminalConnectedUnixMs"] = 1_757_000_000_020
            browser["firstCommand"]["startedUnixMs"] = 1_757_000_000_025
            browser["firstCommand"]["successUnixMs"] = 1_757_000_000_030
            browser["stages"] = {
                "start-click": 1_757_000_000_000,
                "terminal-connected": 1_757_000_000_020,
                "terminal-visible": 1_757_000_000_022,
            }
            write_json(browser_path, browser)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "workload window"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=sample["sample_id"],
                        participant_id=sample["participant_id"],
                        client_rtt_ms=24,
                        output=str(observations),
                        status="success",
                        run_id=f"run_{index}",
                        browser_evidence=str(browser_path),
                        agent_events=str(agent_events),
                        host_delta=str(delta_path),
                            cache_refresh_id="cache-refresh-77",
                        workload_events=None,
                        failure_code=None,
                        teardown="destroyed",
                    )
                )

    def test_client_rtt_outside_the_observed_range_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, _, _ = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = plan["schedule"][0]
            with self.assertRaisesRegex(benchmark.BenchmarkError, "observed range"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=sample["sample_id"],
                        participant_id=sample["participant_id"],
                        client_rtt_ms=80,
                        output=str(observations),
                        status="failure",
                        run_id=None,
                        browser_evidence=None,
                        agent_events=None,
                        host_delta=None,
                        cache_refresh_id=None,
                        workload_events=None,
                        failure_code="launch_failed",
                        teardown="not-needed",
                    )
                )

    def test_acceptance_gate_gates_the_candidate_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = run_manifest(root)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(manifest_path)
            plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")

            def group(median_ms, p95_ms, count=100, failures=0):
                failure_codes = {"launch_failed": failures} if failures else {}
                return {
                    "expected_count": count,
                    "observed_count": count,
                    "success_count": count - failures,
                    "failure_count": failures,
                    "failure_codes": failure_codes,
                    "metrics_ms": {
                        "terminal_first_command_ms": {
                            "count": count - failures,
                            "median": median_ms,
                            "p95": p95_ms,
                            "min": 1,
                            "max": p95_ms,
                        }
                    },
                    "host_counter_deltas": {},
                }

            # The old release is intentionally slow and may fail. That must not
            # decide the gate.
            groups = {}
            for scenario in plan["scenarios"]:
                for condition in benchmark.DEFAULT_CONDITIONS:
                    groups[(scenario, condition, "baseline")] = group(7000, 9200, failures=7)
                    groups[(scenario, condition, "candidate")] = group(1800, 2900)
            accepted = benchmark.acceptance_report(plan, groups, [], 2400)
            self.assertTrue(accepted["pass"], accepted["reasons"])
            self.assertEqual(accepted["measured_sample_count"], 2400)
            self.assertEqual(len(accepted["baseline_failures"]), 12)
            self.assertEqual(accepted["targets"]["gated_implementations"], ["candidate"])
            gated = {cell["implementation"] for cell in accepted["cells"] if cell["gated"]}
            self.assertEqual(gated, {"candidate"})

            # A baseline that is fast is fine; only the candidate is gated.
            fast_baseline = {
                key: group(1500, 1800) for key in groups
            }
            self.assertTrue(benchmark.acceptance_report(plan, fast_baseline, [], 2400)["pass"])

            # A candidate above the p50 target fails the gate.
            over_target = dict(groups)
            key = (plan["scenarios"][0], benchmark.DEFAULT_CONDITIONS[0], "candidate")
            over_target[key] = group(2100, 2600)
            failed = benchmark.acceptance_report(plan, over_target, [], 2400)
            self.assertFalse(failed["pass"])
            self.assertTrue(any("candidate p50" in reason for reason in failed["reasons"]))

            # A candidate above the p95 target fails the gate.
            over_p95 = dict(groups)
            over_p95[key] = group(1900, 4100)
            failed = benchmark.acceptance_report(plan, over_p95, [], 2400)
            self.assertFalse(failed["pass"])
            self.assertTrue(any("candidate p95" in reason for reason in failed["reasons"]))

            # A candidate failure fails the gate, even when the baseline failed more.
            with_failure = dict(groups)
            with_failure[key] = group(1800, 2900, failures=1)
            failed = benchmark.acceptance_report(plan, with_failure, [], 2400)
            self.assertFalse(failed["pass"])
            self.assertTrue(any("candidate failures" in reason for reason in failed["reasons"]))

            # A candidate failure beyond the baseline fails the comparison.
            more_failures = dict(groups)
            more_failures[key] = group(1800, 2900, failures=9)
            failed = benchmark.acceptance_report(plan, more_failures, [], 2400)
            self.assertFalse(failed["pass"])
            self.assertEqual(len(failed["new_failures"]), 1)

            # A missing sample is never a pass.
            incomplete = benchmark.acceptance_report(plan, groups, ["sample-x"], 2399)
            self.assertFalse(incomplete["pass"])

    def test_acceptance_gate_needs_every_planned_sample_in_the_baseline_too(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
            plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")

            def group(count, incomplete):
                return {
                    "expected_count": count,
                    "observed_count": count - incomplete,
                    "success_count": count - incomplete,
                    "failure_count": 0,
                    "failure_codes": {},
                    "metrics_ms": {
                        "terminal_first_command_ms": {
                            "count": count - incomplete,
                            "median": 1800,
                            "p95": 2900,
                            "min": 1,
                            "max": 2900,
                        }
                    },
                    "host_counter_deltas": {},
                }

            groups = {
                (scenario, condition, implementation): group(
                    100, 3 if implementation == "baseline" else 0
                )
                for scenario in plan["scenarios"]
                for condition in benchmark.DEFAULT_CONDITIONS
                for implementation in benchmark.IMPLEMENTATIONS
            }
            report = benchmark.acceptance_report(plan, groups, [], 2364)
            self.assertFalse(report["pass"])
            self.assertTrue(any("planned samples are missing" in reason for reason in report["reasons"]))


    def test_a_failure_record_needs_no_client_rtt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, _, _ = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = plan["schedule"][0]
            record = benchmark.record_sample(
                argparse.Namespace(
                    plan=str(plan_path),
                    sample_id=sample["sample_id"],
                    participant_id=sample["participant_id"],
                    client_rtt_ms=None,
                    output=str(observations),
                    status="failure",
                    run_id=None,
                    browser_evidence=None,
                    agent_events=None,
                    host_delta=None,
                    cache_refresh_id=None,
                    workload_events=None,
                    failure_code="start_failed",
                    teardown="not-needed",
                )
            )
            self.assertEqual(record["status"], "failure")
            self.assertNotIn("client_rtt_ms", record)

    def test_a_leaked_success_is_recorded_and_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = plan["schedule"][0]
            record = benchmark.record_sample(
                argparse.Namespace(
                    plan=str(plan_path),
                    sample_id=sample["sample_id"],
                    participant_id=sample["participant_id"],
                    client_rtt_ms=24,
                    output=str(observations),
                    status="success",
                    run_id="run_0",
                    browser_evidence=str(root / "browser-0.json"),
                    agent_events=str(agent_events),
                    host_delta=str(delta_path),
                    cache_refresh_id=None,
                    workload_events=None,
                    teardown="failed",
                    failure_code=None,
                )
            )
            # The boot metric is kept, and the leaked run is recorded.
            self.assertEqual(record["status"], "success")
            self.assertEqual(record["teardown"], "failed")
            report = benchmark.build_report(
                argparse.Namespace(
                    plan=str(plan_path), observations=str(observations), allow_incomplete=True
                )
            )
            self.assertFalse(report["acceptance"]["pass"])
            self.assertGreaterEqual(report["acceptance"]["teardown_failure_count"], 1)
            self.assertTrue(
                any(
                    "did not finish teardown" in reason
                    for reason in report["acceptance"]["reasons"]
                )
            )

    def test_a_success_without_a_teardown_outcome_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = plan["schedule"][0]
            with self.assertRaisesRegex(benchmark.BenchmarkError, "teardown"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=sample["sample_id"],
                        participant_id=sample["participant_id"],
                        client_rtt_ms=24,
                        output=str(observations),
                        status="success",
                        run_id="run_0",
                        browser_evidence=str(root / "browser-0.json"),
                        agent_events=str(agent_events),
                        host_delta=str(delta_path),
                        cache_refresh_id=None,
                        workload_events=None,
                        teardown=None,
                        failure_code=None,
                    )
                )

    def test_a_success_record_without_a_client_rtt_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = self.campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = plan["schedule"][0]
            with self.assertRaisesRegex(benchmark.BenchmarkError, "measured client RTT"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=sample["sample_id"],
                        participant_id=sample["participant_id"],
                        client_rtt_ms=None,
                        output=str(observations),
                        status="success",
                        run_id="run_0",
                        browser_evidence=str(root / "browser-0.json"),
                        agent_events=str(agent_events),
                        host_delta=str(delta_path),
                        cache_refresh_id=None,
                        workload_events=None,
                        failure_code=None,
                        teardown="destroyed",
                    )
                )


class HostAttestationTest(unittest.TestCase):
    def test_a_plan_needs_a_verified_host_attestation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            path = run_manifest(root)

            for field, value, message in [
                ("verified", False, "not verified"),
                ("environment", "production", "environment benchmark"),
                ("role", "not-a-role", "role must be one of"),
                ("serves_learners", True, "serves_learners does not match"),
                ("hardware_class", "xeon-e5-1620-31g", "hardware class"),
                ("active_vms", 2, "active VMs"),
            ]:
                write_host_attestation(root, **{field: value})
                with self.assertRaisesRegex(benchmark.BenchmarkError, message):
                    benchmark.load_run_manifest(path)
            write_host_attestation(root, isolation_id="a-production-host")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "isolation_id"):
                benchmark.load_run_manifest(path)

    def test_the_fixture_states_the_truth_about_a_production_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, _ = benchmark.load_run_manifest(run_manifest(root))
            self.assertEqual(manifest["host"]["role"], "drained-production")
            self.assertTrue(manifest["host"]["production"])
            self.assertFalse(manifest["host"]["serves_learners"])
            self.assertIn("production", manifest["claim_ceiling"])

        # A production host relabelled as isolated is refused, and an isolated
        # host labelled production is refused too.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            relabelled = run_manifest(root, role="isolated-benchmark", production=True)
            write_host_attestation(
                root, role="isolated-benchmark", production=True
            )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "production=true"):
                benchmark.load_run_manifest(relabelled)

            lying = run_manifest(root, hardware_class="xeon-e5-1620-31g")
            write_host_attestation(
                root, production=False, hardware_class="xeon-e5-1620-31g"
            )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "production"):
                benchmark.load_run_manifest(lying)

    def test_the_plan_records_the_attested_host_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            _, plan, plan_path = load_manifest_and_plan(root, run_manifest(root))

            self.assertEqual(plan["host_attestation"]["hostname"], "bench-eu-1.intar.test")
            self.assertEqual(plan["host_attestation"]["active_vms"], 0)
            self.assertEqual(
                plan["host_attestation"]["sha256"],
                __import__("hashlib").sha256(
                    (root / "host-attestation.json").read_bytes()
                ).hexdigest(),
            )
            # A plan whose attestation was removed cannot be loaded, so no gate
            # can pass without one.
            stripped = dict(plan)
            stripped.pop("host_attestation")
            stripped.pop("plan_sha256")
            stripped["plan_sha256"] = __import__("hashlib").sha256(
                benchmark.canonical_json(stripped)
            ).hexdigest()
            write_json(plan_path, stripped)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "plan host attestation"):
                benchmark.load_plan(plan_path)

    def test_the_report_labels_the_measurement_and_its_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, _ = self._one_failure(root)
            report = benchmark.build_report(
                argparse.Namespace(
                    plan=str(plan_path), observations=str(observations), allow_incomplete=True
                )
            )
            self.assertTrue(report["measurement"]["host_attested"])
            self.assertEqual(report["measurement"]["host_active_vms"], 0)
            self.assertGreaterEqual(len(report["measurement"]["limits"]), 3)

    def _one_failure(self, root: Path):
        write_release_evidence(root, "baseline-release")
        write_release_evidence(root, "candidate-release")
        manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
        plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13", 4, 4)
        plan_path = root / "plan.json"
        write_json(plan_path, plan)
        observations = root / "observations.ndjson"
        sample = plan["schedule"][0]
        benchmark.record_sample(
            argparse.Namespace(
                plan=str(plan_path),
                sample_id=sample["sample_id"],
                participant_id=sample["participant_id"],
                client_rtt_ms=None,
                output=str(observations),
                status="failure",
                run_id=None,
                browser_evidence=None,
                agent_events=None,
                host_delta=None,
                cache_refresh_id=None,
                workload_events=None,
                failure_code="start_failed",
                teardown="not-needed",
            )
        )
        return plan_path, observations, None


class WorkloadOverlapTest(unittest.TestCase):
    def window(self):
        return (1_757_700_000_000, 1_757_700_002_000)

    def test_an_interval_that_started_before_the_window_still_covers_it(self):
        start, end = self.window()
        # Background work parks while a boot is critical, so the boot window can
        # contain no event of its own. The interval is still active.
        events = [workload_event(start - 30_000)]
        overlap = benchmark.workload_overlap(events, "cache-refresh", (start, end))
        self.assertEqual(overlap["required_workloads"], ["cache-refresh"])
        self.assertTrue(overlap["evidence"]["cache-refresh"]["open"])
        self.assertEqual(overlap["evidence"]["cache-refresh"]["start_unix_ms"], start - 30_000)

        # A closed interval that opens before and ends after the window counts too.
        closed = [workload_event(start - 5_000), workload_event(end + 5_000, kind="end")]
        overlap = benchmark.workload_overlap(closed, "cache-refresh", (start, end))
        self.assertFalse(overlap["evidence"]["cache-refresh"]["open"])

    def test_an_interval_that_ended_before_the_window_does_not_count(self):
        start, end = self.window()
        events = [
            workload_event(start - 900_000),
            workload_event(start - 899_000, kind="end"),
        ]
        with self.assertRaisesRegex(benchmark.BenchmarkError, "not proven to overlap"):
            benchmark.workload_overlap(events, "cache-refresh", (start, end))

    def test_a_workload_with_no_events_fails(self):
        start, end = self.window()
        with self.assertRaisesRegex(benchmark.BenchmarkError, "not proven to overlap"):
            benchmark.workload_overlap([], "cache-refresh", (start, end))
        with self.assertRaisesRegex(benchmark.BenchmarkError, "no observable proof"):
            benchmark.workload_overlap([], "unknown-workload", (start, end))

    def test_the_combined_condition_needs_the_archive_half(self):
        start, end = self.window()
        refresh_only = [workload_event(start - 1_000)]
        with self.assertRaisesRegex(benchmark.BenchmarkError, "archive"):
            benchmark.workload_overlap(refresh_only, "cache-refresh+archive", (start, end))

        both = [
            workload_event(start - 1_000),
            workload_event(start - 900, workload="archive", job="run-1-vm-1"),
        ]
        overlap = benchmark.workload_overlap(both, "cache-refresh+archive", (start, end))
        self.assertEqual(
            sorted(overlap["evidence"]), ["archive", "cache-refresh"]
        )
        self.assertEqual(
            overlap["evidence"]["archive"]["start_unix_ms"], start - 900
        )

    def test_host_events_carry_their_kind_and_job(self):
        start, _ = self.window()
        document = workload_events_document(start)
        path = Path(tempfile.mkdtemp()) / "events.json"
        write_json(path, document)
        events = benchmark.workload_events(path)
        self.assertTrue(events)
        for event in events:
            self.assertIn(event["kind"], benchmark.WORKLOAD_EVENT_KINDS)
            self.assertTrue(event["job"])

        broken = dict(document)
        broken["events"] = [{**document["events"][0], "kind": "middle"}]
        write_json(path, broken)
        with self.assertRaisesRegex(benchmark.BenchmarkError, "event kind"):
            benchmark.workload_events(path)

    def test_a_record_cannot_claim_the_archive_half_without_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
            plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")
            plan_path = root / "plan.json"
            write_json(plan_path, plan)
            observations = root / "observations.ndjson"
            sample = next(
                item
                for item in plan["schedule"]
                if item["background_workload"] == "cache-refresh+archive"
                and item["scenario_id"] == "broken-nginx"
            )
            start = 1_757_700_000_000
            refresh_only = root / "refresh-only.json"
            write_json(
                refresh_only,
                {
                    "schema_version": 2,
                    "kind": benchmark.WORKLOAD_EVENTS_KIND,
                    "host": "bench-eu-1.intar.test",
                    "captured_unix_ms": start + 10_000,
                    "events": [workload_event(start - 30_000)],
                },
            )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "archive"):
                benchmark.record_sample(
                    self.background_namespace(
                        root, plan_path, observations, sample, refresh_only, start
                    )
                )

            both = root / "both.json"
            write_json(
                both,
                {
                    "schema_version": 2,
                    "kind": benchmark.WORKLOAD_EVENTS_KIND,
                    "host": "bench-eu-1.intar.test",
                    "captured_unix_ms": start + 10_000,
                    "events": [
                        workload_event(start - 30_000),
                        workload_event(start - 20_000, workload="archive", job="run-1-vm-1"),
                    ],
                },
            )
            record = benchmark.record_sample(
                self.background_namespace(root, plan_path, observations, sample, both, start)
            )
            self.assertEqual(record["workload"]["required_workloads"], ["cache-refresh", "archive"])
            self.assertEqual(sorted(record["workload"]["evidence"]), ["archive", "cache-refresh"])
            report = benchmark.build_report(
                argparse.Namespace(
                    plan=str(plan_path), observations=str(observations), allow_incomplete=True
                )
            )
            self.assertFalse(report["complete"])

    def background_namespace(self, root, plan_path, observations, sample, events_path, start):
        index = 0
        total_ms = 1_800
        browser_path = root / "background-browser.json"
        write_json(
            browser_path,
            {
                "schemaVersion": 2,
                "benchmarkRunId": sample["sample_id"],
                "participantId": sample["participant_id"],
                "variant": sample["implementation"],
                "releaseId": sample["release"]["id"],
                "releaseManifestSha256": sample["release"]["manifest_sha256"],
                "runId": "run-background",
                "scenarioId": sample["scenario_id"],
                "startBoundary": "learner-start-link-click",
                "startUnixMs": start,
                "terminalConnectedUnixMs": start + total_ms - 200,
                "clientRttMs": 24,
                "firstCommand": {
                    "startedUnixMs": start + total_ms - 100,
                    "successUnixMs": start + total_ms,
                    "nonceSha256": "d" * 64,
                    "outputObservedAfterCommand": True,
                },
                "stages": {
                    "start-click": start,
                    "terminal-connected": start + total_ms - 200,
                    "terminal-visible": start + total_ms - 100,
                },
            },
        )
        agent_path = root / "background-agent.ndjson"
        agent_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "run_id": "run-background",
                    "vm": "vm_1",
                    "boot_timing_version": 2,
                    "phase_ms": phase_timings(index),
                }
            )
            + "\n",
            encoding="utf-8",
        )
        delta_path = root / "background-delta.json"
        write_json(delta_path, host_delta())
        return argparse.Namespace(
            plan=str(plan_path),
            sample_id=sample["sample_id"],
            participant_id=sample["participant_id"],
            client_rtt_ms=24,
            output=str(observations),
            status="success",
            run_id="run-background",
            browser_evidence=str(browser_path),
            agent_events=str(agent_path),
            host_delta=str(delta_path),
            cache_refresh_id=manifest_workload_id(sample),
            workload_events=str(events_path),
            teardown="destroyed",
            failure_code=None,
        )

    def test_the_gate_needs_a_proven_background_workload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
            plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")

            def group():
                return {
                    "expected_count": 100,
                    "observed_count": 100,
                    "success_count": 100,
                    "failure_count": 0,
                    "failure_codes": {},
                    "teardown_failure_count": 0,
                    "teardown_failure_samples": [],
                    "metrics_ms": {
                        "terminal_first_command_ms": {
                            "count": 100,
                            "median": 1800,
                            "p95": 2900,
                            "min": 1,
                            "max": 2900,
                        }
                    },
                    "host_counter_deltas": {},
                }

            groups = {
                (scenario, condition, implementation): group()
                for scenario in plan["scenarios"]
                for condition in benchmark.DEFAULT_CONDITIONS
                for implementation in benchmark.IMPLEMENTATIONS
            }
            accepted = benchmark.acceptance_report(plan, groups, [], 2400)
            self.assertTrue(accepted["pass"], accepted["reasons"])

    def test_a_leaked_run_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
            plan = benchmark.create_plan(manifest, manifest_sha256, "fresh-boot-2026-09-13")

            def group(leaked: bool):
                return {
                    "expected_count": 100,
                    "observed_count": 100,
                    "success_count": 100,
                    "failure_count": 0,
                    "failure_codes": {},
                    "teardown_failure_count": 1 if leaked else 0,
                    "teardown_failure_samples": ["broken-nginx--serial-prepared--candidate--001"] if leaked else [],
                    "metrics_ms": {
                        "terminal_first_command_ms": {
                            "count": 100,
                            "median": 1800,
                            "p95": 2900,
                            "min": 1,
                            "max": 2900,
                        }
                    },
                    "host_counter_deltas": {},
                }

            groups = {
                (scenario, condition, implementation): group(False)
                for scenario in plan["scenarios"]
                for condition in benchmark.DEFAULT_CONDITIONS
                for implementation in benchmark.IMPLEMENTATIONS
            }
            self.assertTrue(benchmark.acceptance_report(plan, groups, [], 2400)["pass"])

            key = (plan["scenarios"][0], benchmark.DEFAULT_CONDITIONS[0], "baseline")
            groups[key] = group(True)
            report = benchmark.acceptance_report(plan, groups, [], 2400)
            self.assertFalse(report["pass"])
            self.assertEqual(report["teardown_failure_count"], 1)
            self.assertTrue(
                any("did not finish teardown" in reason for reason in report["reasons"])
            )



class SmokePlanTest(unittest.TestCase):
    def test_a_smoke_plan_is_serial_only_and_never_accepts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))

            # A smoke plan runs the real path on one scenario and one condition,
            # so a small sample can be checked before the full campaign.
            smoke = benchmark.create_plan(
                manifest,
                manifest_sha256,
                "smoke-2026-09-13",
                4,
                1,
                ("serial-prepared",),
                "smoke",
            )
            self.assertEqual(smoke["plan_role"], "smoke")
            self.assertEqual(smoke["conditions"], ["serial-prepared"])
            self.assertEqual(
                {sample["condition"] for sample in smoke["schedule"]}, {"serial-prepared"}
            )
            self.assertTrue(all(sample["launch_concurrency"] == 1 for sample in smoke["schedule"]))
            self.assertEqual(len(smoke["schedule"]), 3 * 2 * 4)

            plan_path = root / "smoke-plan.json"
            write_json(plan_path, smoke)
            loaded = benchmark.load_plan(plan_path)
            self.assertEqual(loaded["plan_role"], "smoke")

            # The gate refuses to call a smoke plan an acceptance result.
            empty = root / "smoke-observations.ndjson"
            empty.write_text("", encoding="utf-8")
            report = benchmark.build_report(
                argparse.Namespace(
                    plan=str(plan_path),
                    observations=str(empty),
                    allow_incomplete=True,
                )
            )
            self.assertFalse(report["acceptance"]["pass"])
            self.assertTrue(
                any("smoke plan" in reason for reason in report["acceptance"]["reasons"])
            )

    def test_a_full_plan_keeps_every_condition(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
            plan = benchmark.create_plan(manifest, manifest_sha256, "full-2026-09-13")
            self.assertEqual(plan["plan_role"], "full")
            self.assertEqual(plan["conditions"], list(benchmark.DEFAULT_CONDITIONS))
            self.assertEqual(len(plan["schedule"]), 2400)

    def test_an_unknown_condition_or_role_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_release_evidence(root, "baseline-release")
            write_release_evidence(root, "candidate-release")
            manifest, manifest_sha256 = benchmark.load_run_manifest(run_manifest(root))
            with self.assertRaisesRegex(benchmark.BenchmarkError, "unknown condition"):
                benchmark.create_plan(
                    manifest, manifest_sha256, "bad", 4, 1, ("serial-prepared", "nope")
                )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "at least one condition"):
                benchmark.create_plan(manifest, manifest_sha256, "bad", 4, 1, ())


class ReuseAttributionTest(unittest.TestCase):
    def test_a_reused_run_needs_the_durable_control_plane_clock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, observations, agent_events, delta_path = CampaignTest().campaign(root)
            plan = benchmark.load_plan(plan_path)
            sample = next(
                item for item in plan["schedule"] if item["implementation"] == "candidate"
            )
            index = plan["schedule"].index(sample)
            browser_path = root / f"browser-{index}.json"
            browser = json.loads(browser_path.read_text(encoding="utf-8"))

            # A reused run recorded with a response clock is refused, because the
            # response clock cannot prove which attempt created the run.
            browser["startReused"] = True
            browser["acceptedUnixSource"] = "browser-receive"
            write_json(browser_path, browser)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "durable control-plane"):
                benchmark.normalize_browser_evidence(
                    browser, sample["run_id"] if "run_id" in sample else f"run_{index}",
                    sample["scenario_id"], True,
                )

            # The durable control-plane time is accepted and recorded.
            browser["acceptedUnixSource"] = "control-plane"
            normalized = benchmark.normalize_browser_evidence(
                browser, f"run_{index}", sample["scenario_id"], True
            )
            self.assertTrue(normalized["startReused"])
            self.assertEqual(normalized["acceptedUnixSource"], "control-plane")

            # An unknown source value is refused.
            browser["acceptedUnixSource"] = "wall-clock"
            with self.assertRaisesRegex(benchmark.BenchmarkError, "unsupported value"):
                benchmark.normalize_browser_evidence(
                    browser, f"run_{index}", sample["scenario_id"], True
                )

    def test_a_fresh_accept_needs_no_reuse_marker(self):
        evidence = browser_evidence("run_1", "broken-nginx", 1_000)
        normalized = benchmark.normalize_browser_evidence(
            evidence, "run_1", "broken-nginx", False
        )
        self.assertNotIn("startReused", normalized)


if __name__ == "__main__":
    unittest.main()
