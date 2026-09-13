#!/usr/bin/env python3
"""Build the host attestation document for one benchmark host.

The campaign driver calls this through the host adapter, with the program
delivered on stdin, so it runs on the host and reads that host's own facts.

Every fact comes from the host it runs on:

- the host name, the CPU model, the CPU count, and the memory are read from
  the kernel's own files,
- the attestation file is a root-provisioned file on that host,
- the live VM count is read from the local agent, and a failure to read it
  stops the attestation instead of reporting an empty host.

This program reads files and one local HTTP endpoint. It changes nothing.

The functions take their inputs as explicit arguments, so a test can call them
with fixture paths. No process setting can redirect them at run time.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

KIND = "vm-boot-benchmark-host-attestation"
SCHEMA_VERSION = 2
REQUIRED_ATTESTATION_KEYS = (
    "isolation_id",
    "controller",
    "controller_lease_id",
    "cpu_class",
    "region",
)
DEFAULT_HOST_PATHS = {
    "hostname": "/proc/sys/kernel/hostname",
    "cpuinfo": "/proc/cpuinfo",
    "meminfo": "/proc/meminfo",
}


class AttestationError(RuntimeError):
    """A controlled error that is safe to print to an operator."""


def read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError as error:
        raise AttestationError("cannot read " + path + ": " + str(error)) from error


def read_identity(paths: dict[str, str] | None = None) -> dict:
    """Read the host name, the CPU model, the CPU count, and the memory."""

    chosen = dict(DEFAULT_HOST_PATHS)
    if paths:
        chosen.update(paths)

    hostname = read_text(chosen["hostname"]).strip()
    if not hostname:
        raise AttestationError("the host name is empty")

    model = ""
    cores = 0
    for line in read_text(chosen["cpuinfo"]).splitlines():
        if line.startswith("model name"):
            model = line.split(":", 1)[1].strip()
        elif line.startswith("processor"):
            cores += 1
    if cores == 0:
        raise AttestationError("cannot read the host CPU count")

    memory_mib = 0
    for line in read_text(chosen["meminfo"]).splitlines():
        if line.startswith("MemTotal:"):
            memory_mib = int(line.split()[1]) // 1024
            break
    if memory_mib == 0:
        raise AttestationError("cannot read the host memory")

    return {
        "hostname": hostname,
        "model": model or "unknown CPU",
        "cpu_cores": cores,
        "memory_mib": memory_mib,
    }


def read_active_vms(agent_url: str, opener=None) -> int:
    """Read the live VM count from the local agent.

    A failure here stops the attestation. An unreadable inventory must never
    look like an empty host.
    """

    url = agent_url.rstrip("/") + "/vms"
    if opener is None:
        opener = urllib.request.urlopen
    try:
        with opener(url, timeout=5) as response:
            inventory = json.loads(response.read())
    except (urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as error:
        raise AttestationError(
            "cannot read the agent VM inventory at " + url + ": " + str(error)
        ) from error
    if not isinstance(inventory, list):
        raise AttestationError("the agent VM inventory is not a list")
    return len(inventory)


def load_attestation_file(path: str) -> dict:
    """Read and check the root-provisioned attestation file."""

    try:
        with open(path, encoding="utf-8") as handle:
            attestation = json.load(handle)
    except FileNotFoundError as error:
        raise AttestationError("the host attestation file is missing: " + path) from error
    except OSError as error:
        raise AttestationError("cannot read " + path + ": " + str(error)) from error
    except json.JSONDecodeError as error:
        raise AttestationError("the host attestation file is not valid JSON") from error
    if not isinstance(attestation, dict):
        raise AttestationError("the host attestation file is not a JSON object")
    missing = [
        key
        for key in REQUIRED_ATTESTATION_KEYS
        if not isinstance(attestation.get(key), str) or not attestation[key]
    ]
    if missing:
        raise AttestationError(
            "the host attestation file is missing: " + ", ".join(missing)
        )
    if attestation.get("environment") != "benchmark":
        raise AttestationError(
            "the host attestation file is not for the benchmark environment"
        )
    if attestation.get("production") is not False:
        raise AttestationError(
            "the host attestation file does not declare production=false"
        )
    return attestation


def build_attestation(
    attestation: dict,
    identity: dict,
    active_vms: int,
    captured_unix_ms: int,
    basis: str,
) -> dict:
    """Build the verified document that the tool and the driver compare."""

    if active_vms != 0:
        raise AttestationError(
            "the host still has " + str(active_vms) + " active VMs; the benchmark host must be empty"
        )
    document = dict(attestation)
    document.update(
        {
            "schema_version": SCHEMA_VERSION,
            "kind": KIND,
            "verified": True,
            "hostname": identity["hostname"],
            "hardware": (
                identity["model"]
                + ", "
                + str(identity["cpu_cores"])
                + " vCPU, "
                + str(identity["memory_mib"])
                + " MiB"
            ),
            "cpu_cores": identity["cpu_cores"],
            "memory_mib": identity["memory_mib"],
            "active_vms": active_vms,
            "captured_unix_ms": captured_unix_ms,
            "basis": basis,
        }
    )
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attestation-file", required=True)
    parser.add_argument("--agent-url", required=True)
    args = parser.parse_args(argv)

    try:
        attestation = load_attestation_file(args.attestation_file)
        identity = read_identity()
        active_vms = read_active_vms(args.agent_url)
        document = build_attestation(
            attestation,
            identity,
            active_vms,
            int(time.time() * 1000),
            "root-provisioned attestation file read on the host over ssh",
        )
    except AttestationError as error:
        print("host-attestation: " + str(error), file=sys.stderr)
        return 4

    sys.stdout.write(json.dumps(document, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
