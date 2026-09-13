import importlib.util
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parent / "vm-boot-benchmark" / "host-attestation.py"
SPEC = importlib.util.spec_from_file_location("host_attestation", SCRIPT)
assert SPEC and SPEC.loader
host_attestation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host_attestation)


def write_fixture_host(root: Path, *, hostname="bench-eu-1.intar.test", cores=24, memory_kib=98304000):
    (root / "hostname").write_text(hostname + "\n", encoding="utf-8")
    cpuinfo = [
        "processor\t: " + str(index)
        + "\nmodel name\t: AMD EPYC 9354 24-Core Processor"
        for index in range(cores)
    ]
    (root / "cpuinfo").write_text("\n".join(cpuinfo) + "\n", encoding="utf-8")
    (root / "meminfo").write_text(
        "MemTotal:       " + str(memory_kib) + " kB\nMemFree:        1024 kB\n", encoding="utf-8"
    )
    return {
        "hostname": str(root / "hostname"),
        "cpuinfo": str(root / "cpuinfo"),
        "meminfo": str(root / "meminfo"),
    }


def attestation(**overrides):
    document = {
        "isolation_id": "bench-eu-1",
        "controller": "intar-host-controller",
        "controller_lease_id": "lease-0123",
        "cpu_class": "prod-24-vcpu",
        "region": "eu-west",
        "environment": "benchmark",
        "production": False,
    }
    document.update(overrides)
    return document


class FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def read(self) -> bytes:
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *args) -> None:
        return None


class HostAttestationTest(unittest.TestCase):
    def test_reads_every_identity_fact_from_the_given_host_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = write_fixture_host(Path(temporary))
            identity = host_attestation.read_identity(paths)

            self.assertEqual(identity["hostname"], "bench-eu-1.intar.test")
            self.assertEqual(identity["model"], "AMD EPYC 9354 24-Core Processor")
            self.assertEqual(identity["cpu_cores"], 24)
            self.assertEqual(identity["memory_mib"], 98304000 // 1024)

    def test_the_default_paths_are_the_kernel_own_files(self):
        # The production default is the real host, never a fixture.
        self.assertEqual(
            host_attestation.DEFAULT_HOST_PATHS["hostname"], "/proc/sys/kernel/hostname"
        )
        self.assertEqual(host_attestation.DEFAULT_HOST_PATHS["cpuinfo"], "/proc/cpuinfo")
        self.assertEqual(host_attestation.DEFAULT_HOST_PATHS["meminfo"], "/proc/meminfo")

    def test_no_environment_variable_can_redirect_the_program(self):
        source = SCRIPT.read_text(encoding="utf-8")
        # The module never imports os, so os.environ cannot reach it.
        self.assertNotIn("import os", source)
        self.assertNotIn("os.environ", source)
        self.assertNotIn("getenv", source)

    def test_a_missing_kernel_file_is_an_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = write_fixture_host(Path(temporary))
            paths["cpuinfo"] = str(Path(temporary) / "missing-cpuinfo")
            with self.assertRaisesRegex(host_attestation.AttestationError, "cannot read"):
                host_attestation.read_identity(paths)

    def test_an_empty_host_name_is_an_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = write_fixture_host(Path(temporary), hostname="")
            with self.assertRaisesRegex(host_attestation.AttestationError, "host name is empty"):
                host_attestation.read_identity(paths)

    def test_the_live_vm_count_comes_from_the_agent_and_fails_closed(self):
        calls = []

        def opener(url, timeout=None):
            calls.append(url)
            return FakeResponse(b"[]")

        self.assertEqual(
            host_attestation.read_active_vms("http://127.0.0.1:8080", opener=opener), 0
        )
        self.assertEqual(calls, ["http://127.0.0.1:8080/vms"])

        def busy(url, timeout=None):
            return FakeResponse(json.dumps([{"name": "vm-1"}]).encode())

        self.assertEqual(
            host_attestation.read_active_vms("http://127.0.0.1:8080", opener=busy), 1
        )

        def broken(url, timeout=None):
            raise OSError("connection refused")

        with self.assertRaisesRegex(
            host_attestation.AttestationError, "cannot read the agent VM inventory"
        ):
            host_attestation.read_active_vms("http://127.0.0.1:8080", opener=broken)

        def wrong_shape(url, timeout=None):
            return FakeResponse(b"{}")

        with self.assertRaisesRegex(host_attestation.AttestationError, "not a list"):
            host_attestation.read_active_vms("http://127.0.0.1:8080", opener=wrong_shape)

    def test_builds_the_verified_document(self):
        identity = {
            "hostname": "bench-eu-1.intar.test",
            "model": "AMD EPYC 9354",
            "cpu_cores": 24,
            "memory_mib": 96000,
        }
        document = host_attestation.build_attestation(
            attestation(), identity, 0, 1_757_700_000_000, "read on the host over ssh"
        )
        self.assertEqual(document["kind"], host_attestation.KIND)
        self.assertTrue(document["verified"])
        self.assertEqual(document["hostname"], "bench-eu-1.intar.test")
        self.assertEqual(document["active_vms"], 0)
        self.assertIn("24 vCPU", document["hardware"])
        self.assertEqual(document["isolation_id"], "bench-eu-1")

    def test_a_host_with_active_vms_cannot_be_attested(self):
        identity = {"hostname": "h", "model": "m", "cpu_cores": 1, "memory_mib": 1}
        with self.assertRaisesRegex(host_attestation.AttestationError, "active VMs"):
            host_attestation.build_attestation(
                attestation(), identity, 2, 1_757_700_000_000, "basis"
            )

    def test_the_attestation_file_must_be_for_the_benchmark_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "attestation.json"
            path.write_text(json.dumps(attestation(environment="production")), encoding="utf-8")
            with self.assertRaisesRegex(
                host_attestation.AttestationError, "benchmark environment"
            ):
                host_attestation.load_attestation_file(str(path))

            path.write_text(json.dumps(attestation(production=True)), encoding="utf-8")
            with self.assertRaisesRegex(host_attestation.AttestationError, "production=false"):
                host_attestation.load_attestation_file(str(path))

            path.write_text(json.dumps({"isolation_id": "x"}), encoding="utf-8")
            with self.assertRaisesRegex(host_attestation.AttestationError, "is missing"):
                host_attestation.load_attestation_file(str(path))

            path.write_text("{not json", encoding="utf-8")
            with self.assertRaisesRegex(host_attestation.AttestationError, "not valid JSON"):
                host_attestation.load_attestation_file(str(path))

            with self.assertRaisesRegex(host_attestation.AttestationError, "is missing"):
                host_attestation.load_attestation_file(str(Path(temporary) / "absent.json"))

    def test_main_refuses_a_remote_environment_override_argument(self):
        # The program takes only the two documented options, so an operator
        # cannot pass a fixture root or an inventory file at run time.
        for flag in ("--host-root", "--inventory", "--root"):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    host_attestation.main(
                        [
                            "--attestation-file",
                            "/etc/x.json",
                            "--agent-url",
                            "http://127.0.0.1:8080",
                            flag,
                            "/tmp",
                        ]
                    )


if __name__ == "__main__":
    unittest.main()
