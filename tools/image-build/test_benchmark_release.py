import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path


SCRIPT = Path(__file__).with_name("benchmark-release.py")
SPEC = importlib.util.spec_from_file_location("benchmark_release", SCRIPT)
assert SPEC and SPEC.loader
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


TARGET = """scenario \"klustered-04-repair-workload-chain\" {
  kino {
    probe \"k3s-running\" {
      description = \"The k3s control plane should be running\"
    }
  }

  vm \"control-plane\" {
    step \"existing\" {
      command {
        cmd = \"true\"
      }
    }

    probes = [\"k3s-running\"]
  }
}
"""


class BenchmarkReleaseTest(unittest.TestCase):
    def make_source(self, root: Path, target: str = TARGET) -> Path:
        source = root / "source"
        courses = source / "courses"
        target_path = courses / "klustered/klustered-04-repair-workload-chain/scenario.hcl"
        target_path.parent.mkdir(parents=True)
        target_path.write_text(target, encoding="utf-8")
        (target_path.parent / "lecture.md").write_bytes(b"lecture markdown\n")
        (courses / "klustered/course.md").write_bytes(b"course markdown\n")
        other = courses / "linux-basics/01-broken-nginx"
        other.mkdir(parents=True)
        (other / "scenario.hcl").write_text('scenario "broken-nginx" {}\n', encoding="utf-8")
        (other / "lecture.md").write_bytes(b"other markdown\n")
        (courses / "linux-basics/course.md").write_bytes(b"other course markdown\n")
        return source

    def prepare_args(self, source: Path, destination: Path, record: Path, variant: str):
        return benchmark.make_parser().parse_args(
            [
                "prepare",
                "--source-root",
                str(source),
                "--destination-root",
                str(destination),
                "--record",
                str(record),
                "--revision",
                "benchmark-123",
                "--source-sha",
                "a" * 40,
                "--workflow-sha",
                "c" * 40,
                "--harness-fingerprint",
                "d" * 64,
                "--cli-version",
                "0.4.4",
                "--implementation",
                "candidate",
                "--sample-mode",
                "warm",
                "--variant",
                variant,
                "--iteration",
                "1",
                "--build-label",
                "candidate-warm",
                "--builder-profile",
                "candidate-v12",
                "--expected-builder-binary-sha256",
                "b" * 64,
                "--external-preparation-evidence-id",
                "builder-prep-1",
            ]
        )

    def test_runtime_copy_preserves_markdown_and_changes_only_target_description(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_source(root)
            destination = root / "prepared"
            record_path = root / "record.json"

            record = benchmark.prepare_catalog(
                self.prepare_args(source, destination, record_path, "runtime")
            )

            source_markdown = benchmark.markdown_snapshot(source / "courses")
            destination_markdown = benchmark.markdown_snapshot(destination / "courses")
            self.assertEqual(source_markdown, destination_markdown)
            target = (destination / "courses" / benchmark.TARGET_SCENARIO_RELATIVE_PATH).read_text(
                encoding="utf-8"
            )
            self.assertIn('description = "The k3s control plane should be running [benchmark benchmark-123]"', target)
            self.assertNotIn('description = "The k3s control plane should be running"\n', target)
            self.assertEqual(record["catalog"]["complete_candidate_image_count"], 2)
            self.assertEqual(record["catalog"]["expected_rebuilt_image_count"], 2)
            self.assertTrue(json.loads(record_path.read_text(encoding="utf-8"))["catalog"]["markdown_preserved"])
            for scenario in (destination / "courses").rglob("scenario.hcl"):
                self.assertIn("# intar-image-build-benchmark revision: benchmark-123\n", scenario.read_text())

    def test_late_step_is_inserted_before_the_final_probe_list(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_source(root)
            destination = root / "prepared"
            record_path = root / "record.json"
            source_other = (
                source / "courses/linux-basics/01-broken-nginx/scenario.hcl"
            ).read_bytes()

            record = benchmark.prepare_catalog(
                self.prepare_args(source, destination, record_path, "late-step")
            )

            target = (destination / "courses" / benchmark.TARGET_SCENARIO_RELATIVE_PATH).read_text(
                encoding="utf-8"
            )
            self.assertLess(target.index('step "benchmark-late-noop"'), target.index("probes ="))
            self.assertIn("          true\n", target)
            self.assertNotIn('step "benchmark-late-noop"', (source / "courses" / benchmark.TARGET_SCENARIO_RELATIVE_PATH).read_text())
            self.assertIn("# intar-image-build-benchmark revision: benchmark-123\n", target)
            self.assertEqual(
                source_other,
                (destination / "courses/linux-basics/01-broken-nginx/scenario.hcl").read_bytes(),
            )
            self.assertEqual(record["catalog"]["expected_rebuilt_image_count"], 1)
            self.assertTrue(
                record["catalog"]["forced_registry_rebuild"]["unrelated_scenario_hcl_preserved"]
            )

    def test_late_step_fails_closed_when_the_final_vm_shape_changes(self):
        invalid = TARGET.replace('    probes = ["k3s-running"]\n', '    probes = [\n      "k3s-running",\n    ]\n')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_source(root, invalid)

            with self.assertRaisesRegex(benchmark.BenchmarkError, "known final VM shape"):
                benchmark.prepare_catalog(
                    self.prepare_args(source, root / "prepared", root / "record.json", "late-step")
                )

    def test_upload_receipt_requires_the_variant_rebuild_count(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_source(root)
            record_path = root / "record.json"
            benchmark.prepare_catalog(
                self.prepare_args(source, root / "prepared", record_path, "late-step")
            )

            accepted = benchmark.make_parser().parse_args(
                ["accept", "--record", str(record_path), "--queued", "1", "--assigned", "4"]
            )
            record = benchmark.record_bundle_acceptance(accepted)
            self.assertEqual(record["rebuild"]["queued_image_builds"], 1)
            self.assertEqual(record["rebuild"]["assigned_image_builds_observed"], 4)

    def test_observer_provenance_preserves_the_original_harness_fingerprint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.make_source(root)
            record_path = root / "record.json"
            prepared = benchmark.prepare_catalog(
                self.prepare_args(source, root / "prepared", record_path, "unchanged")
            )

            observed = benchmark.make_parser().parse_args(
                [
                    "observe",
                    "--record",
                    str(record_path),
                    "--workflow-sha",
                    "f" * 40,
                    "--workflow-run-id",
                    "42",
                ]
            )
            record = benchmark.record_observer_provenance(observed)

            self.assertEqual(
                record["context"]["harness_fingerprint"],
                prepared["context"]["harness_fingerprint"],
            )
            self.assertEqual(record["observer_provenance"][0]["workflow_run_id"], 42)

    def complete_record(
        self,
        root: Path,
        implementation: str,
        revision: str,
        duration: int,
        mode: str,
        iteration: int,
        rebuilt_images: int = 13,
    ):
        path = root / f"{implementation}-{revision}.json"
        benchmark.write_json(
            path,
            {
                "schema_version": benchmark.RECORD_SCHEMA_VERSION,
                "status": "ready",
                "context": {
                    "revision": revision,
                    "implementation": implementation,
                    "sample_mode": mode,
                    "source_sha": "c" * 40,
                    "workflow_sha": "d" * 40,
                    "harness_fingerprint": "f" * 64,
                    "variant": "unchanged",
                    "iteration": iteration,
                    "builder_profile": f"{implementation}-profile",
                    "operator_attested_builder_binary_sha256": "e" * 64,
                    "cache_preparation": {
                        "source": "operator-attested external preparation",
                        "evidence_id": f"prep-{implementation}-{iteration}",
                        "verified_by_harness": False,
                    },
                    "cli_version": (
                        benchmark.BASELINE_V11_CLI_VERSION
                        if implementation == "baseline"
                        else "0.4.4"
                    ),
                },
                "events": [],
                "catalog": {
                    "complete_candidate_image_count": 13,
                    "expected_rebuilt_image_count": rebuilt_images,
                },
                "rebuild": {"queued_image_builds": rebuilt_images},
                "result": {
                    "complete_candidate_image_count": 13,
                    "rebuilt_image_count": rebuilt_images,
                },
                "metrics": {
                    "acceptance_to_all_build_and_host_warm_ms": duration,
                    "bundle_start_to_all_build_and_host_warm_ms": duration,
                },
            },
        )
        return str(path)

    def test_comparison_enforces_warm_and_no_cache_thresholds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline = [
                self.complete_record(
                    root, "baseline", f"base-{index}", 200 + index, "warm", index + 1
                )
                for index in range(3)
            ]
            candidate = [
                self.complete_record(
                    root, "candidate", f"candidate-{index}", 99 + index, "warm", index + 1
                )
                for index in range(3)
            ]
            warm = benchmark.compare_samples(baseline, candidate, "warm")
            self.assertTrue(warm["passed"])
            self.assertGreaterEqual(warm["candidate_speedup"], 2.0)

            cold_baseline = [
                self.complete_record(
                    root,
                    "baseline",
                    f"cold-base-{index}",
                    100 + index,
                    "no-cache-prepared",
                    index + 1,
                )
                for index in range(3)
            ]
            cold_candidate = [
                self.complete_record(
                    root,
                    "candidate",
                    f"cold-candidate-{index}",
                    121 + index,
                    "no-cache-prepared",
                    index + 1,
                )
                for index in range(3)
            ]
            cold = benchmark.compare_samples(cold_baseline, cold_candidate, "no-cache-prepared")
            self.assertFalse(cold["passed"])

            late_baseline = [
                self.complete_record(
                    root, "baseline", f"late-base-{index}", 200 + index, "warm", index + 1, 1
                )
                for index in range(3)
            ]
            late_candidate = [
                self.complete_record(
                    root,
                    "candidate",
                    f"late-candidate-{index}",
                    150 + index,
                    "warm",
                    index + 1,
                    1,
                )
                for index in range(3)
            ]
            late = benchmark.compare_samples(late_baseline, late_candidate, "warm")
            self.assertFalse(late["threshold"]["applies"])
            self.assertIsNone(late["threshold_passed"])
            self.assertTrue(late["passed"])

    def test_recovered_observer_record_is_not_a_strict_comparison_sample(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            record_path = Path(
                self.complete_record(root, "baseline", "recovered", 100, "warm", 1)
            )
            record = benchmark.load_record(record_path)
            record["observer_provenance"] = [{"workflow_run_id": 42}]
            benchmark.write_json(record_path, record)

            with self.assertRaisesRegex(benchmark.BenchmarkError, "recovered observer records"):
                benchmark.sample_from_record(benchmark.load_record(record_path), "baseline", "warm")

    def test_status_observation_records_available_build_phase_timestamps(self):
        record = {
            "schema_version": benchmark.RECORD_SCHEMA_VERSION,
            "events": [
                {"name": "bundle_accepted", "at_unix_ms": 100, "at_rfc3339": "test"}
            ],
            "observations": [],
            "metrics": {},
        }
        benchmark.observe_status(
            record,
            {
                "ok": False,
                "state": "building",
                "build_count": 2,
                "host_count": 1,
                "build_status_counts": {"building": 2},
                "build_phase_counts": {"building": 1, "publishing": 1},
                "ready_host_count": 0,
                "all_builds_succeeded": False,
                "all_hosts_ready": False,
                "build_updated_at_min_unix_ms": 1,
                "build_updated_at_max_unix_ms": 2,
                "failed_build_count": 0,
            },
        )
        events = {event["name"] for event in record["events"]}
        self.assertIn("first_build_phase_building", events)
        self.assertIn("first_build_phase_publishing", events)
        self.assertIsInstance(record["metrics"]["queue_observed_until_building_ms"], int)

    def test_registry_request_declares_the_benchmark_user_agent(self):
        request = benchmark.registry_request("revision-1", "test-token")
        self.assertEqual(request.get_header("User-agent"), benchmark.BENCHMARK_USER_AGENT)
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_http_error_diagnostic_is_bounded_and_does_not_echo_authentication(self):
        headers = Message()
        headers["Content-Type"] = "text/html; charset=utf-8"
        headers["CF-Ray"] = "abc123"
        headers["Authorization"] = "Bearer should-not-appear"
        error = urllib.error.HTTPError(
            "https://intar.dev/registry/v1/builds/revisions/revision-1?tools=stable",
            403,
            "forbidden",
            headers,
            io.BytesIO(b"<html><title>Access denied by edge policy</title></html>"),
        )

        message = benchmark.http_error_message(error)

        self.assertIn("HTTP 403", message)
        self.assertIn("content_type=text/html; charset=utf-8", message)
        self.assertIn("cf_ray=abc123", message)
        self.assertIn("diagnostic=Access denied by edge policy", message)
        self.assertNotIn("should-not-appear", message)


if __name__ == "__main__":
    unittest.main()
