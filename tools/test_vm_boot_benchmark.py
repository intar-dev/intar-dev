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


def phase_timings(offset=0):
    phases = {key: index + offset for index, key in enumerate(benchmark.AGENT_TIMING_KEYS)}
    host_keys = benchmark.AGENT_TIMING_KEYS[:benchmark.AGENT_TIMING_KEYS.index("total_ms")]
    phases["total_ms"] = sum(phases[key] for key in host_keys)
    return phases


def host_delta(vm_name="vm_1"):
    return {
        "schema_version": 1,
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


def browser_evidence(run_id, scenario_id, start):
    return {
        "runId": run_id,
        "scenarioId": scenario_id,
        "startBoundary": "learner-start-link-click",
        "startUnixMs": start,
        "terminalConnectedUnixMs": start + 20,
        "firstCommand": {
            "startedUnixMs": start + 25,
            "successUnixMs": start + 30,
            "nonceSha256": "d" * 64,
            "outputObservedAfterCommand": True,
        },
        "stages": {
            "start-click": start,
            "terminal-connected": start + 20,
        },
    }


class VmBootBenchmarkTest(unittest.TestCase):
    def plan_args(self, *extra):
        return benchmark.make_parser().parse_args(
            [
                "plan",
                "--output",
                "unused.json",
                "--plan-id",
                "fresh-boot-v1",
                "--scenario",
                "broken-nginx",
                "--scenario-vm-count",
                "broken-nginx=1",
                "--scenario",
                "fundamentals-target",
                "--scenario-vm-count",
                "fundamentals-target=1",
                "--scenario",
                "klustered-target",
                "--scenario-vm-count",
                "klustered-target=3",
                "--participant",
                "bench-a",
                "--participant",
                "bench-b",
                "--participant",
                "bench-c",
                "--participant",
                "bench-d",
                "--baseline-release-id",
                "baseline-release",
                "--baseline-manifest-sha256",
                "a" * 64,
                "--candidate-release-id",
                "candidate-release",
                "--candidate-manifest-sha256",
                "b" * 64,
                *extra,
            ]
        )

    def test_plan_has_100_samples_per_release_and_separates_conditions(self):
        plan = benchmark.create_plan(self.plan_args())

        self.assertEqual(len(plan["schedule"]), 3 * 3 * 2 * 100)
        self.assertEqual(plan["conditions"], list(benchmark.DEFAULT_CONDITIONS))
        self.assertEqual(plan["primary_metric"], "terminal_first_command_ms")
        self.assertEqual(plan["percentile_method"], "nearest-rank")
        concurrent_groups = {}
        for sample in plan["schedule"]:
            if sample["condition"] == "concurrency-4":
                concurrent_groups.setdefault(sample["launch_group"], []).append(sample)
        for group in concurrent_groups.values():
            self.assertEqual(group[0]["launch_concurrency"], 4)
            self.assertEqual(len({sample["participant_id"] for sample in group}), 4)

        serial_blocks = [
            sample
            for sample in plan["schedule"]
            if sample["condition"] == "serial" and sample["scenario_id"] == "broken-nginx"
        ]
        self.assertEqual(
            [sample["implementation"] for sample in serial_blocks[::4][:4]],
            ["baseline", "candidate", "candidate", "baseline"],
        )

    def test_concurrent_plan_needs_distinct_participants(self):
        args = self.plan_args()
        args.participant = ["bench-a"]
        with self.assertRaisesRegex(benchmark.BenchmarkError, "distinct participants"):
            benchmark.create_plan(args)

    def test_host_delta_rejects_counter_rollback_and_keeps_pressure_separate(self):
        before = {
            "schema_version": 1,
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
            "schema_version": 1,
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
            "schema_version": 1,
            "kind": "host-pressure-snapshot",
            "captured_unix_ms": 10,
            "host_pressure_us": {
                resource: {"some_total_us": 2, "full_total_us": 1}
                for resource in benchmark.PSI_RESOURCES
            },
        }
        after = {
            "schema_version": 1,
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

    def test_agent_log_extraction_requires_all_phase_fields_and_never_copies_log_text(self):
        fields = ["run_id=run_1", "vm=vm_1", "boot_timing_version=2"]
        fields.extend(f"{key}={value}" for key, value in phase_timings().items())
        event = benchmark.parse_agent_timing_line("INFO vm booted " + " ".join(fields))
        self.assertEqual(event["run_id"], "run_1")
        self.assertEqual(event["phase_ms"]["guest_kino_ms"], benchmark.AGENT_TIMING_KEYS.index("guest_kino_ms"))
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
            benchmark.agent_phase_timings({**event, "phase_ms": {**phase_timings(), "total_ms": 0}})

    def test_multi_vm_agent_evidence_requires_each_planned_vm(self):
        events = [
            {
                "schema_version": 1,
                "run_id": "run_1",
                "vm": "control",
                "boot_timing_version": 2,
                "phase_ms": phase_timings(10),
            },
            {
                "schema_version": 1,
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

    def test_browser_evidence_requires_remote_output_after_the_nonce_command(self):
        evidence = browser_evidence("run_1", "broken-nginx", 1_000)
        evidence["firstCommand"]["outputObservedAfterCommand"] = False
        with self.assertRaisesRegex(benchmark.BenchmarkError, "output after the command"):
            benchmark.normalize_browser_evidence(evidence, "run_1", "broken-nginx")

    def test_record_and_report_keep_failures_out_of_percentiles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self.plan_args(
                "--condition",
                "serial",
                "--samples-per-implementation",
                "4",
            )
            args.scenario = ["broken-nginx"]
            args.scenario_vm_count = ["broken-nginx=1"]
            args.participant = ["bench-a"]
            plan = benchmark.create_plan(args)
            plan_path = root / "plan.json"
            benchmark.write_json(plan_path, plan)
            observations = root / "observations.ndjson"
            delta_path = root / "host-delta.json"
            benchmark.write_json(delta_path, host_delta())

            agent_events = root / "agent-events.ndjson"
            events = []
            for index, item in enumerate(plan["schedule"]):
                if index == 0:
                    record_args = argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=item["sample_id"],
                        participant_id="bench-a",
                        output=str(observations),
                        status="failure",
                        run_id=None,
                        browser_evidence=None,
                        agent_events=None,
                        host_delta=None,
                        cache_refresh_id=None,
                        failure_code="launch_failed",
                    )
                    benchmark.record_sample(record_args)
                    continue
                run_id = f"run_{index}"
                events.append(
                    {
                        "schema_version": 1,
                        "run_id": run_id,
                        "vm": "vm_1",
                        "boot_timing_version": 2,
                        "phase_ms": phase_timings(index),
                    }
                )
            agent_events.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
            )

            for index, item in enumerate(plan["schedule"]):
                if index == 0:
                    continue
                run_id = f"run_{index}"
                browser_path = root / f"browser-{index}.json"
                browser = browser_evidence(run_id, "broken-nginx", 1_000 + index * 100)
                browser.update(
                    {
                        "schemaVersion": 1,
                        "benchmarkRunId": item["sample_id"],
                        "participantId": "bench-a",
                        "variant": item["implementation"],
                        "releaseId": item["release"]["id"],
                        "releaseManifestSha256": item["release"]["manifest_sha256"],
                    }
                )
                benchmark.write_json(browser_path, browser)
                record_args = argparse.Namespace(
                    plan=str(plan_path),
                    sample_id=item["sample_id"],
                    participant_id="bench-a",
                    output=str(observations),
                    status="success",
                    run_id=run_id,
                    browser_evidence=str(browser_path),
                    agent_events=str(agent_events),
                    host_delta=str(delta_path),
                    cache_refresh_id=None,
                    failure_code=None,
                )
                benchmark.record_sample(record_args)

            report = benchmark.build_report(
                argparse.Namespace(
                    plan=str(plan_path), observations=str(observations), allow_incomplete=False
                )
            )
            self.assertTrue(report["complete"])
            baseline = next(
                group
                for group in report["groups"]
                if group["implementation"] == "baseline"
            )
            self.assertEqual(baseline["failure_count"], 1)
            self.assertEqual(baseline["metrics_ms"]["terminal_first_command_ms"]["count"], 3)
            self.assertEqual(report["comparisons"][0]["condition"], "serial")

    def test_refresh_sample_requires_a_refresh_identifier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self.plan_args(
                "--condition",
                "cache-refresh",
                "--samples-per-implementation",
                "4",
            )
            args.scenario = ["broken-nginx"]
            args.scenario_vm_count = ["broken-nginx=1"]
            args.participant = ["bench-a"]
            plan = benchmark.create_plan(args)
            plan_path = root / "plan.json"
            benchmark.write_json(plan_path, plan)
            with self.assertRaisesRegex(benchmark.BenchmarkError, "cache refresh ID"):
                benchmark.record_sample(
                    argparse.Namespace(
                        plan=str(plan_path),
                        sample_id=plan["schedule"][0]["sample_id"],
                        participant_id="bench-a",
                        output=str(root / "observations.ndjson"),
                        status="failure",
                        run_id=None,
                        browser_evidence=None,
                        agent_events=None,
                        host_delta=None,
                        cache_refresh_id=None,
                        failure_code="launch_failed",
                    )
                )


if __name__ == "__main__":
    unittest.main()
