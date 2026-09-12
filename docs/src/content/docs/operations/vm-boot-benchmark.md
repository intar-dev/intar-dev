---
title: Fresh VM boot benchmark
description: Measure new VM startup time without a VM pool, pause state, or memory snapshot.
---

Use this runbook to compare two complete, deployed runtime releases. The main
result is the time from the learner selecting Start to one successful command
round trip in the terminal. It also records the host and guest phases that
explain a slow boot.

Every sample must start a new VM. Do not use a running VM pool, paused VM,
memory snapshot, or an existing active Scenario run as a sample.

## Built-in browser production check

For an explicitly requested production check, use five serial fresh starts per
scenario before and after the change. Use the same browser account, host, and
scenario IDs. Finish teardown before the next start. Record failures and host
pressure; do not clear caches or add a concurrent load to production. Report
count, median, minimum, and maximum. This small operational comparison does not
establish a reliable p95 or replace the isolated benchmark below.

Deploy measurement-only changes before collecting the baseline. Open the
lecture page with `?bootBenchmark=1`, then select its normal Start link. The
opt-in is captured at that click and applies only to a newly accepted run.
After SSH connects, the terminal sends one encoded `printf` nonce. It writes
one `intar:boot-benchmark` console record only when remote output returns that
nonce. The console record contains timing fields and the nonce hash, not
terminal contents or credentials. Reconnecting does not send another command.
Use the built-in browser's console reader to collect these records.

Agent events must have `boot_timing_version=2`. `queue_ms` starts at VM-create
API entry. `terminal_publish_ms` ends after terminal publication and worker
registration. The ten host phase fields sum exactly to `total_ms`: each is the
difference between rounded cumulative monotonic timestamps. Guest phase fields
are details, not additional host phases. In particular, `guest_ssh_service_ms`
already includes `guest_ssh_keys_ms`.

Collect early-boot diagnostics in separate runs after command timing finishes:
`sudo dmesg`, `systemd-analyze time`,
`systemd-analyze critical-chain intar-scenario.service ssh.service`,
`systemd-analyze plot`, and the supervisor's `[intar-runtime]` serial markers.
The supervisor uses `Type=simple`, so use its own markers to measure its work.
Keep the kernel/initrd, systemd, supervisor, and host readiness-delivery spans
separate. Keep every release manifest and the prior catalog for rollback.

## Before the benchmark

Use a dedicated benchmark environment. An idle production host is not an
isolated benchmark host. Select an isolated host, record its isolation ID, and
ensure that it has no learner runs before the first sample.

Prepare two complete release manifests. Each manifest must identify the web
application, agent, jailerd, Cloud Hypervisor, root image, and guest-tools/Kino
pin. The benchmark tool stores the SHA-256 digest of each manifest. A candidate
catalog revision can select candidate scenario content, but it does not select
a Kino or guest-tools disk for one run. Deploy those pins as part of the
complete environment release.

Build the baseline with the measurement-only browser markers and agent boot
logging before any speed change. An older application or agent does not meet
this evidence contract. Then compare it with the Kino tools release, followed
by the agent and browser release.

Use hosts with the same CPU model, memory, storage, network path, and VM quota.
If two matched hosts are needed, rotate baseline and candidate blocks across
them and retain the host identity in each release manifest. Do not compare
unmatched hosts as one result.

Use four separate, authorized benchmark users for four-way concurrency. Each
user needs a separate Playwright storage-state file. A user can have only one
active run, so do not reuse a user in the same four-run launch group. For a
serial sample, destroy the run and wait until the VM is absent before starting
the next sample.

Record the current target catalog IDs and VM counts for these three scenarios:

- Broken Nginx: `broken-nginx`
- one Fundamentals scenario
- one Klustered scenario

Do not guess the other IDs or any VM count. Record both values from the
deployed target catalog in the plan. The count makes the collector reject a
partial Klustered run.

## Create the schedule

Create one plan before starting either release. It creates 1,800 samples: 100
baseline and 100 candidate boots for each of three scenarios under serial,
four-way concurrency, and active cache-refresh conditions. The tool alternates
baseline and candidate blocks for each scenario and condition.

Use the `launch_group` field in the schedule to run a block. Run its four
`concurrency-4` rows at the same time with their four different participants.
Run serial and cache-refresh rows one at a time.

```sh
python3 tools/vm-boot-benchmark.py plan \
  --output evidence/fresh-boot-plan.json \
  --plan-id fresh-boot-2026-09-10 \
  --scenario broken-nginx \
  --scenario-vm-count broken-nginx=<deployed-vm-count> \
  --scenario <fundamentals-scenario-id> \
  --scenario-vm-count <fundamentals-scenario-id>=<deployed-vm-count> \
  --scenario <klustered-scenario-id> \
  --scenario-vm-count <klustered-scenario-id>=<deployed-vm-count> \
  --participant bench-a \
  --participant bench-b \
  --participant bench-c \
  --participant bench-d \
  --baseline-release-id <baseline-release-id> \
  --baseline-manifest-sha256 <baseline-manifest-sha256> \
  --candidate-release-id <candidate-release-id> \
  --candidate-manifest-sha256 <candidate-manifest-sha256>
```

Use one environment and manifest for the baseline blocks and another for the
candidate blocks. Do not change a production host between adjacent samples.
The plan identifies the deployed release; it does not apply a release.

`cache-refresh` samples require a cache-refresh ID. Start the normal cache
refresh in the selected environment and use the same recorded ID for the
related samples. The report does not combine this condition with a normal
prepared-cache condition.

Filesystem-cold samples are optional and must use a separate isolated host.
Add `--condition filesystem-cold --filesystem-cold-isolation-id <id>` only for
that host. Do not clear caches on a production host.

## Collect one sample

Run the Playwright collector with the storage state for the planned participant.
It opens the supplied learner page and clicks its visible Start link. It rejects
a reused run, waits for the terminal, and sends a unique `printf` nonce. It only
records a successful command after the nonce arrives in a remote WebSocket
output frame. Local input echo and `terminal-input-output` do not count.

Use the release ID and manifest digest from the matching plan sample. The
runner does not select a guest-tools pin. It records the identity of the
already deployed environment.

```sh
bun tools/vm-boot-benchmark/playwright-runner.ts \
  --origin <selected-environment-origin> \
  --start-page <same-origin-learner-lecture-path> \
  --storage-state <participant-storage-state.json> \
  --scenario-id <planned-scenario-id> \
  --variant <baseline-or-candidate> \
  --release-id <planned-release-id> \
  --release-manifest-sha256 <planned-manifest-sha256> \
  --participant-id <planned-participant-id> \
  --run-id <planned-sample-id> \
  --on-run-accepted-output evidence/<sample>-accepted.json \
  --output evidence/<sample>-browser.json
```

The runner writes the accepted-run file before it waits for the terminal. Use
that file to start the VM-cgroup snapshot while the browser collector is still
running.

The collector writes browser evidence with these values:

- `startUnixMs`: learner Start click
- `terminalConnectedUnixMs`: SSH terminal connection
- `firstCommand`: nonce command start, remote-output success, and nonce hash
- `stages`: browser timing marks, including module and font loading

Take a host-pressure snapshot immediately before starting the browser runner.
On the scenario host, take the first VM-cgroup snapshot as soon as the
accepted-run file gives the new run ID. Take the second host-pressure and
VM-cgroup snapshots after the command succeeds. The helper reads the local
agent inventory, host PSI files, and the VM cgroup only. It does not create,
stop, or modify a VM.

The first cgroup snapshot can start after VM creation. The report therefore
keeps both the final cgroup CPU and I/O totals at command success and the
observed interval delta between snapshots. Use the final total for full boot
work. Use the interval only to compare work after the first snapshot.

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

Join the three evidence sources into the plan. For a failed start, use
`--status failure --failure-code <safe_code>` without browser, agent, or host
files. Do not turn a failure into a successful zero-duration record.

```sh
python3 tools/vm-boot-benchmark.py record \
  --plan evidence/fresh-boot-plan.json \
  --sample-id <planned-sample-id> \
  --participant-id <planned-participant-id> \
  --status success \
  --run-id <new-run-id> \
  --browser-evidence evidence/<sample>-browser.json \
  --agent-events evidence/<sample>-agent-events.ndjson \
  --host-delta evidence/<sample>-host-delta.json \
  --output evidence/fresh-boot-observations.ndjson
```

For a `cache-refresh` sample, add `--cache-refresh-id <refresh-id>` to that
command. Do not add it to a serial or concurrency sample.

After evidence is recorded, destroy the run with the same participant session.
For a serial sample, this command must finish before the next sample starts. A
failed VM is still live until every VM has completed teardown.

```sh
bun tools/vm-boot-benchmark/playwright-cleanup.ts \
  --origin <selected-environment-origin> \
  --storage-state <participant-storage-state.json> \
  --run-id <new-run-id>
```

For a four-way group, run cleanup for all four accepted run IDs and wait for all
four commands to finish before the next group. The cleanup tool reports only an
absent run or a run where every VM completed teardown.

## Report and review

After all planned samples finish, produce the report:

```sh
python3 tools/vm-boot-benchmark.py report \
  --plan evidence/fresh-boot-plan.json \
  --observations evidence/fresh-boot-observations.ndjson \
  --output evidence/fresh-boot-report.json
```

The report fails if a sample is missing, duplicated, from another plan, from a
different release, or from the wrong cache condition. It reports p50 and p95
with the nearest-rank method. Failed boots are counted but are not part of a
duration percentile.

Review terminal first-command time first. Review
`slowest_vm_terminal_ready_ms` separately; it is the largest agent
terminal-ready time in the run. Then review terminal connection, guest phase
timings, CPU throttling, VM CPU use, VM I/O, and host CPU, memory, and I/O
pressure. A lower p50 alone is not enough to release a candidate. Keep the
prior release available until the candidate has lower terminal time, no
unexplained p95 regression, and no added startup failures.

## Release gate

Do not roll out from this report until the isolated-host benchmark is complete.
Keep the previous tools pin and application release for rollback. For a host
change, use the normal drain procedure, then verify host health, each published
scenario, SSH recording, and Klustered K3s readiness before the host accepts
learner runs.
