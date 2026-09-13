---
title: Fresh VM boot benchmark
description: Measure new VM startup time on an isolated host and apply the hard p50 and p95 gates.
---

Use this runbook to compare two complete, deployed runtime releases. The main
result is the time from the learner selecting Start to one successful command
round trip in the terminal. The plan holds 2,400 samples: 100 baseline and 100
candidate boots for each of three scenarios under four conditions. The targets
are p50 <= 2,000 ms and p95 <= 4,000 ms, and they apply to the candidate only.

The baseline is the release that is already deployed. It is slower by
definition, some of its boots may fail, and neither of those facts decides the
release gate. The baseline has to be complete because it is the comparison
value, and the candidate must not add a failure against it.

Every sample must start a new VM. Do not use a running VM pool, paused VM,
memory snapshot, or an existing active Scenario run as a sample. Measure from
one EU learner client against one isolated benchmark host. An idle production
host is not an isolated host.

## Readiness rule

A sample is ready only after these events:

1. the scenario host completes the host security seal (`quota_seal_ms`),
2. the learner page shows a visible, editable terminal, and
3. the terminal records PTY output that contains the benchmark nonce.

A connected WebSocket is not readiness. A hidden or warm socket can answer with
the nonce while the terminal stays invisible, so the nonce alone is not proof
that a learner reached a terminal. The collector therefore checks visibility
itself, and the tool stores both sources in `readiness` and refuses a record
whose basis is not `host-security-seal` and `recorded-pty-output`.

### The visible-terminal mark

A candidate sample must carry a `terminal-visible` stage. The rule is:

```text
terminalConnectedUnixMs <= stages["terminal-visible"] <= firstCommand.startedUnixMs
```

The collector writes that mark itself: it waits for the terminal element, the
connected status, the terminal view, and the terminal input to be visible and
editable in the page, and then reads the page clock. A page that reports a
connected socket while the terminal stays hidden cannot produce the mark, so a
candidate sample without it is refused.

The baseline is the old release and does not write the mark, so the baseline is
accepted without it and is still measured from the learner Start click. If a
baseline sample does carry the mark, the same ordering rule applies.

The primary metric does not change: it stays the interval from the learner
Start click to the first successful command round trip. The visible mark is a
gate and it is recorded, not a new status and not a new metric.

## Before the benchmark

Measure each release bundle before you write the run manifest. The helper is
read-only. It opens the downloaded bundle, measures each artifact, and writes
the evidence that the plan references. It never changes a host, a registry, or
a deployment, and it never compares a declared digest with itself.

The bundle is the downloaded release payload plus a `bundle.json` that names
the seven components of the release:

- `web`, `agent`, `jailerd`, `gateway` application artifacts,
- `kernel` and `initrd` boot artifacts,
- the `images` catalog, which pins a Kino ABI.

The candidate must pin the current Kino ABI 2. The baseline of a comparison is
the artifact that is already deployed, so it may still pin the older ABI 1.
This is how an old artifact is measured; it is not a runtime compatibility
path, and the runtime keeps no dual support.

`bundle.json` gives each component an ID and a file name. For `images` it also
gives `kino_abi`.

~~~json
{
  "schema_version": 2,
  "kind": "intar-release-bundle",
  "release_id": "release-2026-09-13",
  "components": {
    "web": {"id": "intar-dev-worker-2026-09-13", "file": "intar-dev-worker.tar.gz"},
    "agent": {"id": "intar-agent-0.12.12", "file": "intar-agent.tar.gz"},
    "jailerd": {"id": "intar-jailerd-0.12.12", "file": "intar-jailerd.tar.gz"},
    "gateway": {"id": "stargate-gateway-0.9.0", "file": "stargate-gateway.tar.gz"},
    "kernel": {"id": "vmlinuz-6.12.9", "file": "vmlinuz"},
    "initrd": {"id": "initrd-6.12.9", "file": "initrd"},
    "images": {"id": "catalog-2026-09-13", "file": "catalog.json", "kino_abi": 2}
  }
}
~~~

```sh
python3 tools/vm-boot-benchmark.py validate-release-bundle \
  --bundle evidence/bundles/baseline-release \
  --manifest evidence/bundles/baseline-release/bundle.json \
  --release-id baseline-release \
  --output evidence/releases/baseline-release.evidence.json
```

The variant decides the ABI rule, so no operator flag can move it. The run
manifest refuses a candidate whose images are not Kino ABI 2, and it accepts a
baseline with ABI 1 or ABI 2. Any other ABI is refused.

The evidence file records the measured SHA-256 and size of every component,
the image ABI, and one bundle digest. The helper stops on a missing artifact
or on an ABI that the release is not allowed to use.

## Write the run manifest

One run manifest holds the isolated host, the EU client, the participants, the
scenarios with their deployed VM counts, the two release evidence files, and
the background workload IDs, rates, and time windows. Record the scenario IDs
and VM counts from the deployed catalog. Do not guess them.

```json
{
  "schema_version": 2,
  "kind": "vm-boot-benchmark-run-manifest",
  "run_id": "fresh-boot-2026-09-13",
  "foreground_workload": {
    "workload_id": "learner-boot-2026-09-13",
    "controller": "intar-host-controller",
    "controller_lease_id": "lease-0123"
  },
  "host": {
    "controller": "intar-host-controller",
    "controller_lease_id": "lease-0123",
    "isolation_id": "bench-eu-1",
    "production": false,
    "cpu_class": "prod-24-vcpu",
    "region": "eu-west",
    "attestation_file": "host-attestation.json"
  },
  "client": {"region": "eu", "observed_rtt_ms": {"min_ms": 18, "max_ms": 42}},
  "participants": ["bench-a", "bench-b", "bench-c", "bench-d"],
  "scenarios": [
    {"id": "broken-nginx", "vm_count": 1},
    {"id": "<fundamentals-scenario-id>", "vm_count": 1},
    {"id": "<klustered-scenario-id>", "vm_count": 3}
  ],
  "releases": {
    "baseline": {"id": "baseline-release", "evidence_file": "releases/baseline-release.evidence.json"},
    "candidate": {"id": "candidate-release", "evidence_file": "releases/candidate-release.evidence.json"}
  },
  "background_workloads": {
    "cache-refresh": {
      "workload_id": "cache-refresh-77",
      "rate_per_min": 3,
      "window": {"start_unix_ms": 1757700000000, "end_unix_ms": 1757710000000}
    },
    "cache-refresh+archive": {
      "workload_id": "cache-refresh-78",
      "rate_per_min": 3,
      "window": {"start_unix_ms": 1757710000000, "end_unix_ms": 1757720000000}
    }
  },
  "randomization": {"seed": "fresh-boot-2026-09-13"}
}
```

`attestation_file` is the output of the adapter's `attest` verb, captured
before the plan is written. The manifest cannot load without it, so no plan,
no campaign, and no passing gate exists without a verified isolated host. The
file must state `verified: true`, `environment: benchmark`,
`production: false`, zero active VMs, and the same `isolation_id`,
`controller`, `controller_lease_id`, `cpu_class`, and `region` as the
manifest. The plan then records the hostname, the hardware, the CPU count,
the memory, and the file digest.

`observed_rtt_ms` is the range that the operator measured on the same
client that runs the campaign. Every sample records its own measured round
trip time, and the tool refuses a sample outside that range. The client
latency is a recorded measurement, not a fixed constant.

The four participants are separate, authorized benchmark users with separate
Playwright storage-state files. A user can have only one active run, so
four-way groups never reuse a user. The start request also needs a unique
idempotency key for each sample: a repeated key returns the run that the first
request admitted, and that run is not a fresh VM.

## Validate before you start

Run the dry run first. It reads files only, and it fails closed on a
production host, a host attestation that is unverified or does not match the
manifest, zero active VMs that the host did not confirm, a client without an
observed RTT range, release evidence that does not cover the seven components
and the allowed image ABI, or a plan that does not match the manifest.

```sh
python3 tools/vm-boot-benchmark.py dry-run \
  --run-manifest evidence/run-manifest.json \
  --output evidence/dry-run.json
```

## Create the schedule

```sh
python3 tools/vm-boot-benchmark.py plan \
  --run-manifest evidence/run-manifest.json \
  --plan-id fresh-boot-2026-09-13 \
  --output evidence/fresh-boot-plan.json
```

The plan holds 2,400 samples in 24 cells of 100. The four conditions are:

| Condition | Launch concurrency | Background workload |
| --- | --- | --- |
| `serial-prepared` | 1 | none |
| `concurrent-4-prepared` | 4 | none |
| `serial-background-cache` | 1 | cache refresh |
| `concurrent-4-background-cache-archive` | 4 | cache refresh and archive |

The seed in the run manifest shuffles the block order and the first
implementation of each block. The same seed and manifest rebuild the same
schedule, and the plan stores `randomization.block_order` for review.

Use the `launch_group` field to run a block. Run its four
`concurrent-4-*` rows at the same time with their four different
participants. Run serial rows one at a time.

## Run the campaign

The campaign driver runs the whole plan. It starts the existing browser runner
for each sample, collects host evidence through one trusted adapter, joins the
evidence with the existing tool, and destroys every run with the existing
cleanup tool. It does not create a VM, install a package, or change a host.

```sh
bun tools/vm-boot-benchmark/campaign.ts \
  --plan evidence/fresh-boot-plan.json \
  --observations evidence/fresh-boot-observations.ndjson \
  --evidence-dir evidence/campaign \
  --output evidence/campaign-report.json \
  --origin <selected-environment-origin> \
  --start-page </same-origin-learner-lecture-path> \
  --participant-storage-state bench-a=<bench-a.json> \
  --participant-storage-state bench-b=<bench-b.json> \
  --participant-storage-state bench-c=<bench-c.json> \
  --participant-storage-state bench-d=<bench-d.json> \
  --host-adapter <trusted-operator-program>
```

The driver walks the plan in launch groups. A group with launch concurrency 4
starts its four samples at the same time with four different participants. A
serial group starts one sample at a time. The driver waits for the teardown of
a group before it starts the next group.

Some behaviour is worth knowing before the first group:

- The driver writes the campaign report after every group, so a stopped
  campaign still has a readable report.
- A sample that the observations file already has is skipped. A campaign that
  stops in the middle can be restarted with the same arguments and continues
  with the missing samples.
- A failed boot is recorded as a failure with a code, and the run is still
  destroyed. Cleanup runs after a failure, not only after a success.
- The driver measures a sample while its run is live, then tears the run down,
  then records the observation with the real teardown outcome. A run whose
  teardown does not complete is recorded as `teardown: failed`, it fails the
  acceptance gate for its cell, and the campaign stops before the next group.
  A resumed campaign refuses to start while the observations file holds a
  sample whose teardown failed, so a leaked run cannot be skipped.
- The host-pressure window is per group in a concurrent group, because those
  VMs overlap in time. In a serial group it is per sample.

### The host adapter

The tool cannot read a remote host, so host evidence comes from one trusted
operator program. The driver calls that program with a fixed verb and
validated arguments, and each verb receives an `--output` path inside
`--evidence-dir`. Nothing in the plan file is ever executed.

| Verb | Arguments | Output |
| --- | --- | --- |
| `attest` | none | host identity and isolation facts |
| `pressure-capture` | none | `capture-host-pressure` output |
| `cgroup-capture` | `--run-id`, `--expected-vm-count`, `--wait-seconds` | `capture-run-host` output |
| `workload-events` | `--start-unix-ms`, `--end-unix-ms` | background workload events |
| `agent-events` | `--run-id` | `extract-agent-events` output |

Exit code 3 means the verb is not supported.

`tools/vm-boot-benchmark/host-adapter.sh` is a ready adapter for one host over
SSH. It reads the host attestation file, copies the repository tool to the
host over stdin so the host needs nothing installed, and reads the agent
journal. Its `attest` verb refuses a file that is not for the benchmark
environment, a host that is not production=false, or a host that still has
active VMs.

Three programs are shipped to the host on stdin, so the host needs nothing
installed and every host fact is read on the host:

- `tools/vm-boot-benchmark/host-attestation.py` for `attest`. It reads the
  host name, the CPU model and count, and the memory from that host's kernel
  files, reads the root-provisioned attestation file, and reads the live VM
  count from the local agent. A failure to read the VM inventory stops the
  attestation; an unreadable inventory never looks like an empty host.
- `tools/vm-boot-benchmark/workload-events.py` for `workload-events`.
- `tools/vm-boot-benchmark.py` for `pressure-capture`, `cgroup-capture`,
  and `agent-events`.

No process setting can redirect these programs: they take their inputs as
arguments, and the adapter validates and shell-quotes every value before it
reaches ssh. A value with unsupported characters, a non-numeric count, or a
leading dash is refused before any remote command runs.

### What the attest verb needs

The `attest` output must carry `isolation_id`, `controller`,
`controller_lease_id`, `cpu_class`, `region`, and
`production`. The driver compares each value with the run manifest and stops
before the first sample on a difference.

The plan cannot be written without the attestation file that this verb
produces, so a campaign always starts on an attested host. The driver compares
the live attestation with the identity recorded in the plan and stops on a
difference.

The benchmark host needs one root-provisioned file,
`/etc/intar-benchmark/attestation.json`, that states `isolation_id`,
`controller`, `controller_lease_id`, `cpu_class`, `region`,
`environment: benchmark`, and `production: false`. The adapter adds the
hostname, the hardware, the CPU count, the memory, and the live VM count from
the host itself. There is no such provisioned host yet, so a live campaign is
blocked until one exists.

A live campaign always needs a verified attestation. There is no bypass flag,
and a host adapter that cannot attest stops the campaign before the first
sample. The plan cannot even exist without an attested host.

## Prove the background workload

For a background condition the driver reads the host workload events for the
batch window and passes them to `record` with `--workload-events`.

The helper reads the journal from a lookback before the window and reports
intervals, not single events: an archive job that started before the window
and is still running, or one that completes after it, still covers the window.
That matters because background cache work parks between blocks while a VM
boot is critical, so a boot window can contain no event of its own while the
workload is plainly active.

The tool then requires an active interval that spans each sample's own window,
and a combined condition needs every one of its workloads. An interval that
ended before the window, a window with no workload at all, or a
`cache-refresh+archive` sample with only cache evidence fails the sample with
`background_workload_not_observed`.

The cache lines are scope independent: the current agent logs them in both of
its refresh scopes, so a scope rename or a new scope does not change the
mapping.

The workloads and their real agent log lines are:

| Workload | Opens | Closes |
| --- | --- | --- |
| `cache-refresh` | `running image cache pass`, `image cache scrub batch` | remains open |
| `archive` | `queued durable archive job`, `started archive job`, `archive job failed and will be retried` | `archive job completed` |

The declared workload rate is an operator input. The proof is that the workload
was active across the window, not the rate.

## Collect one sample by hand

Run the Playwright collector with the storage state of the planned
participant. It opens the learner page, measures the client round trip,
clicks the visible Start link, waits for a visible and editable terminal,
writes the `terminal-visible` stage from the page clock, and only then sends
one encoded `printf` nonce. It records a successful command only after the
nonce arrives in a remote WebSocket output frame. Local input echo and
terminal input events do not count.

A sample counts only when the run was created by this Start attempt. The
collector reads the run's durable `acceptedAt` from the Start response and
accepts it when that time is at or after the attempt start. A transport retry
inside one attempt returns the same run with `reused: true`; that is still this
attempt's run, so it is accepted. A run accepted before the attempt started, or
a response without a usable `acceptedAt`, is refused, because a pre-existing run
would be measured as a fresh boot.

The collector checks visibility itself. It waits for the terminal element, the
connected status, the terminal view, and the terminal input, and it refuses a
terminal whose input is not editable, so a warm or hidden socket cannot reach
the nonce step.

```sh
bun tools/vm-boot-benchmark/playwright-runner.ts \
  --origin <selected-environment-origin> \
  --start-page <same-origin-learner-lecture-path> \
  --storage-state <participant-storage-state.json> \
  --scenario-id <planned-scenario-id> \
  --variant <baseline-or-candidate> \
  --release-id <planned-release-id> \
  --release-manifest-sha256 <planned-release-evidence-sha256> \
  --participant-id <planned-participant-id> \
  --run-id <planned-sample-id> \
  --on-run-accepted-output evidence/<sample>-accepted.json \
  --output evidence/<sample>-browser.json
```

The runner writes the accepted-run file before it waits for the terminal. Use
that file to start the VM cgroup snapshot while the collector is still
running.

Take a host-pressure snapshot immediately before starting the browser runner.
On the scenario host, take the first VM-cgroup snapshot as soon as the
accepted-run file gives the new run ID. Take the second host-pressure and
VM-cgroup snapshots after the command succeeds.

```sh
python3 tools/vm-boot-benchmark.py capture-host-pressure \
  --output evidence/<sample>-pressure-before.json

python3 tools/vm-boot-benchmark.py capture-run-host \
  --run-id <new-run-id> \
  --expected-vm-count <planned-vm-count> \
  --wait-seconds 60 \
  --output evidence/<sample>-host-before.json

# Run this after the successful terminal command.
python3 tools/vm-boot-benchmark.py capture-host-pressure \
  --output evidence/<sample>-pressure-after.json

python3 tools/vm-boot-benchmark.py capture-run-host \
  --run-id <new-run-id> \
  --expected-vm-count <planned-vm-count> \
  --output evidence/<sample>-host-after.json

python3 tools/vm-boot-benchmark.py host-delta \
  --before evidence/<sample>-host-before.json \
  --after evidence/<sample>-host-after.json \
  --host-pressure-before evidence/<sample>-pressure-before.json \
  --host-pressure-after evidence/<sample>-pressure-after.json \
  --output evidence/<sample>-host-delta.json
```

Export the relevant `intar-agent` journal lines to a local file. The extractor
keeps only the run ID, VM ID, and numeric timing fields. It does not copy log
text, bearer tokens, or request data into the evidence file.

```sh
python3 tools/vm-boot-benchmark.py extract-agent-events \
  --input evidence/<sample>-intar-agent.log \
  --output evidence/<sample>-agent-events.ndjson
```

Join the evidence into the plan. For a failed start, use
`--status failure --failure-code <safe_code>` without browser, agent, or host
files. Do not turn a failure into a successful zero-duration record.

```sh
python3 tools/vm-boot-benchmark.py record \
  --plan evidence/fresh-boot-plan.json \
  --sample-id <planned-sample-id> \
  --participant-id <planned-participant-id> \
  --client-rtt-ms <measured RTT from the browser evidence> \
  --status success \
  --run-id <new-run-id> \
  --browser-evidence evidence/<sample>-browser.json \
  --agent-events evidence/<sample>-agent-events.ndjson \
  --host-delta evidence/<sample>-host-delta.json \
  --output evidence/fresh-boot-observations.ndjson
```

For a background workload sample, add
`--cache-refresh-id <planned background workload ID>`. The tool refuses an
ID that does not match the plan, and it refuses a sample whose window is
outside the declared workload window. Do not add the flag to a prepared
condition.

After evidence is recorded, destroy the run with the same participant
session. For a serial sample, this command must finish before the next sample
starts. A failed VM is still live until every VM has completed teardown.

```sh
bun tools/vm-boot-benchmark/playwright-cleanup.ts \
  --origin <selected-environment-origin> \
  --storage-state <participant-storage-state.json> \
  --run-id <new-run-id>
```

For a four-way group, run cleanup for all four accepted run IDs and wait for
all four commands to finish before the next group.

## Report and review

```sh
python3 tools/vm-boot-benchmark.py report \
  --plan evidence/fresh-boot-plan.json \
  --observations evidence/fresh-boot-observations.ndjson \
  --output evidence/fresh-boot-report.json
```

The report fails if a sample is missing, duplicated, from another plan or run
manifest, from a different release, or from the wrong condition. It reports
p50 and p95 with the nearest-rank method, and it records the slowest samples
of every condition, including every sample above the p95 target.

The acceptance gate in the report passes only when all of these are true:

- every planned sample of the campaign, in both releases, has an observation,
- every sample finished teardown, in both releases,
- every candidate sample carries a valid `terminal-visible` mark,
- no candidate cell records a failure,
- p50 and p95 of every candidate cell are inside the targets, and
- the candidate adds no failure against the baseline of the same scenario and
  condition.

The plan also carries the attested host identity, so a report cannot exist
without a verified host, and the report repeats that identity in
`measurement` together with `measurement.limits`. Those limits are part of
the result: an unproven background workload or an unattested host is never a
pass.

The baseline is not gated on performance. It is the old release, so its p50
and p95 are expected to be above the targets, and a slow baseline must not
make the gate fail. Its failures are recorded in
`acceptance.baseline_failures` and stay in the report as the comparison
value.

A partial campaign, a campaign with a candidate failure, or a campaign that
has not run reports `acceptance.pass: false`. Percentiles are never taken
from a subset of a cell, so a failure cannot be hidden by a smaller sample.

Percentiles and the gate use the primary metric only:
`terminal_first_command_ms`. Review the agent phases, the terminal readiness
span, CPU throttling, VM CPU and I/O counters, and host pressure after the gate,
because a lower p50 alone is not enough to release a candidate.

## Release gate

Do not roll out from this report until the isolated-host benchmark is complete
and the gate passes. Keep the previous release evidence and the prior catalog
for the rollback. For a host change, use the normal drain procedure, then
verify host health, each published scenario, SSH recording, and Klustered K3s
readiness before the host accepts learner runs.

## Honest bounds

This runbook and its tooling do not prove the targets. The targets are
unproven until a complete campaign runs on the isolated host and the gate
passes. No campaign has run, and the host is not provisioned: the host adapter
needs a root-provisioned attestation file that does not exist yet.

No test has run the adapter against a real SSH target. The adapter tests run
the shipped programs against a fixture host through a fake ssh, and the
campaign tests run the driver against a simulated runner, so plumbing and
refusals are covered while a live end-to-end sample is not.

The host attestation proves what the host reported and what the manifest
declared. It cannot detect a host that lies, and an operator with root on the
benchmark host can write any attestation file they choose.

The learner interface shows no benchmark status, and this work adds no new
learner-visible state.
