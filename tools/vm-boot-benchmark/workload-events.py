#!/usr/bin/env python3
"""Read background workload events from one scenario host.

The campaign driver calls this through the host adapter with the capture
window in host time. It reads the agent journal from a lookback before that
window, so an interval that started earlier is still visible, and it prints
one event per real agent log line.

Two workloads are observed: cache-refresh and archive. The log formats that
define them are in WORKLOAD_MESSAGES below, which is the only place they are
listed.

Background work parks between blocks while a VM boot is critical, and a boot
window is short, so a window can contain no workload event of its own. The
driver correlates intervals instead of single events for that reason.

This program reads a journal and prints JSON. It changes nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time

DEFAULT_LOOKBACK_MS = 900_000
FIELD = re.compile(r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>[^\s]+)")
# A needle in the log line -> (workload, kind). The tracing output carries both
# the human message and the event name, so both are accepted. The archive end
# needs the completion line: the timing event also fires on a retry.
WORKLOAD_MESSAGES = (
    ("running image cache pass", "cache-refresh", "start"),
    ("image cache scrub batch", "cache-refresh", "start"),
    ("queued durable archive job", "archive", "start"),
    ("scenario_run_archive_queued", "archive", "start"),
    ("started archive job", "archive", "start"),
    ("scenario_run_archive_started", "archive", "start"),
    ("archive job failed and will be retried", "archive", "start"),
    ("scenario_run_archive_retry", "archive", "start"),
    ("archive job completed", "archive", "end"),
)


def classify(message: str) -> tuple[str, str] | None:
    for needle, workload, kind in WORKLOAD_MESSAGES:
        if needle in message:
            return workload, kind
    return None


def job_identity(message: str, fallback: str) -> str:
    fields = {match.group("name"): match.group("value").strip('"') for match in FIELD.finditer(message)}
    run_id = fields.get("run_id")
    vm = fields.get("vm")
    if run_id and vm:
        return (run_id + "-" + vm)[:120]
    if run_id:
        return run_id[:120]
    return fallback


def journal_events(unit: str, start_unix_ms: int, end_unix_ms: int) -> list[dict]:
    command = [
        "journalctl",
        "-u",
        unit,
        "-o",
        "json",
        "--no-pager",
        "--since",
        "@" + str(start_unix_ms // 1000),
        "--until",
        "@" + str(end_unix_ms // 1000 + 1),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        raise SystemExit("cannot read the agent journal: " + completed.stderr.strip())

    events: list[dict] = []
    for line in completed.stdout.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = record.get("MESSAGE")
        if not isinstance(message, str):
            continue
        classified = classify(message)
        if classified is None:
            continue
        workload, kind = classified
        raw_time = record.get("__REALTIME_TIMESTAMP")
        if raw_time is None:
            continue
        unix_ms = int(raw_time) // 1000
        events.append(
            {
                "unix_ms": unix_ms,
                "workload": workload,
                "kind": kind,
                "job": job_identity(message, workload),
                "source": "intar-agent",
                "message": next(
                    needle for needle, _, _ in WORKLOAD_MESSAGES if needle in message
                ),
            }
        )
    return events


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-unix-ms", type=int, required=True)
    parser.add_argument("--end-unix-ms", type=int, required=True)
    parser.add_argument("--lookback-ms", type=int, default=DEFAULT_LOOKBACK_MS)
    parser.add_argument("--unit", default="intar-agent")
    args = parser.parse_args(argv)

    if args.end_unix_ms <= args.start_unix_ms:
        print("workload-events: the window must end after it starts", file=sys.stderr)
        return 2
    if args.lookback_ms < 0:
        print("workload-events: the lookback must not be negative", file=sys.stderr)
        return 2

    lookback_start = args.start_unix_ms - args.lookback_ms
    events = journal_events(args.unit, lookback_start, args.end_unix_ms)
    if not events:
        print(
            "workload-events: no workload event was logged between "
            + str(lookback_start)
            + " and "
            + str(args.end_unix_ms),
            file=sys.stderr,
        )
        return 4

    hostname = subprocess.run(
        ["hostname", "-f"], capture_output=True, text=True, check=False
    ).stdout.strip() or "unknown-host"
    document = {
        "schema_version": 2,
        "kind": "vm-boot-benchmark-workload-events",
        "host": hostname,
        "window_start_unix_ms": args.start_unix_ms,
        "window_end_unix_ms": args.end_unix_ms,
        "lookback_start_unix_ms": lookback_start,
        "captured_unix_ms": int(time.time() * 1000),
        "events": sorted(events, key=lambda event: event["unix_ms"]),
    }
    sys.stdout.write(json.dumps(document, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
