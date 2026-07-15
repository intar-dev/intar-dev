# Live E2E Proof

This check is the deployed proof required by the refactor plan. It exercises the
Worker, D1 catalog, R2 image registry, host desired-state cache, agent, Stargate,
guest terminal path, network isolation, teardown, and R2 run artifacts.

The checked-in Worker configuration and deployment workflow define only the
production `https://intar.dev` environment. There is no staging Worker in this
repository. A breaking production proof must therefore keep general scheduling
disabled, pin work to one drained canary host, and use the production secure
session cookie; an example staging hostname is not a deployment target.

## Prerequisites

- The website Worker is deployed with the current build.
- For the builder path, at least one Linux/KVM builder host is registered,
  connected, and visible on the admin Builds page.
- At least one Linux/KVM agent host is registered, connected, enabled for
  scenarios, and reporting jailer-v2, hard CPU quota, Landlock, unified
  cgroup-v2 CPU accounting, KVM, nftables, and reflink support.
- `sudo -u intar-agent env XDG_CACHE_HOME=/var/cache/intar-agent
  XDG_STATE_HOME=/var/cache/intar-agent/state /usr/local/bin/intar-agent
  --doctor --config /etc/intar-agent/config.toml` exits 0 on that agent host.
- `sudo /usr/lib/intar/intar-jailerd-self-test` exits 0 on that host. Doctor is
  read-only; only this artifact-backed root test boots the pinned VMM and
  proves disposable unit/cgroup/jail/network setup, quota, and cleanup.
- You have an authenticated admin browser cookie for the deployed website.
- For direct publish mode, you have the registry publish token and the scenario
  image manifest plus matching kernel/initrd boot artifacts.

## Builder Queue Proof

Use this path for the deployed production proof after a push to `main`. The
Images workflow uploads a source bundle with revision `${GITHUB_SHA::12}`; the
builder downloads that bundle, builds the raw-zstd image, publishes it, and
uploads logs. The live harness waits for the corresponding admin build rows
before starting a run.

Against the deployed HTTPS site, better-auth issues its session cookie with
the `__Secure-` prefix; the plain name below only exists on plain-HTTP
`wrangler dev` instances.

```sh
export INTAR_LIVE_BASE_URL="https://intar.dev"
export INTAR_LIVE_COOKIE="__Secure-better-auth.session_token=..."
export INTAR_LIVE_BUILD_REV="<first-12-characters-of-main-commit-sha>"

just live-e2e "--skip-publish --build-rev ${INTAR_LIVE_BUILD_REV}"
```

For a pinned agent host:

```sh
export INTAR_LIVE_HOST_ID="host-id-from-dashboard"
just live-e2e "--skip-publish --build-rev ${INTAR_LIVE_BUILD_REV}"
```

The build wait defaults to 15 minutes:

```sh
just live-e2e "--skip-publish --build-rev ${INTAR_LIVE_BUILD_REV} --wait-build-ms 1800000"
```

For local builder development, run the builder once on a Linux/KVM machine. Start
from `crates/intar-builder/deploy/config.example.toml` for
`/etc/intar-builder/config.toml`, then fill in the local host credentials and keep
`[qemu] accelerator = "kvm"` so this proof exercises the same direct boot path as
staging. `builder.sample.amd64.hcl` is the image-build HCL consumed by
`intar-image-cli`; it is not the builder daemon TOML.

For an offline build-only check, set `[bridge] enabled = false` in the builder
config. `run-once` will build the raw-zstd image and record local builder state,
but it will skip registry publish and log upload:

```sh
intar-builder doctor --config /etc/intar-builder/config.toml
just bundle-images pair-ping builder.sample.amd64.hcl local-e2e true
intar-builder run-once \
  --config /etc/intar-builder/config.toml \
  --scenario pair-ping \
  --bundle dist/bundles/local-e2e.tar.gz
```

For a `run-once` check against a local Worker, start a `wrangler dev` control
plane from the website build output. The builder daemon must be able to reach the
configured `base_url`; `http://127.0.0.1:8788` works only when `wrangler dev` and
`intar-builder run-once` run on the same Linux/KVM host. If the builder is on a
different machine, bind or tunnel the Worker to an address reachable from that
builder and use that URL in the host config. Create `website/.dev.vars` locally
with development values:

```dotenv
BETTER_AUTH_URL="http://127.0.0.1:8788"
BETTER_AUTH_SECRET="local-better-auth-secret-at-least-32-bytes"
AGENT_JWT_SECRET="local-agent-jwt-secret-at-least-32-bytes"
REGISTRY_PUBLISH_TOKEN="local-registry-publish-token"
GITHUB_CLIENT_ID="github-oauth-client-id"
GITHUB_CLIENT_SECRET="github-oauth-client-secret"
```

The GitHub OAuth app callback URL for this local Worker is:

```text
http://127.0.0.1:8788/api/auth/callback/github
```

Then initialize local D1 state, approve your GitHub username, and run the
Worker:

```sh
export GITHUB_USERNAME="your-github-username"
cd website
fnm exec bun run build
fnm exec bun run db:bootstrap:local
fnm exec bunx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "INSERT INTO access_allowlist (github_username, approved_by, approved_at) VALUES (lower('${GITHUB_USERNAME}'), NULL, cast(unixepoch('subsecond') * 1000 as integer)) ON CONFLICT(github_username) DO UPDATE SET approved_by = NULL, approved_at = excluded.approved_at;"
fnm exec bunx wrangler dev --config dist/server/wrangler.json --port 8788
```

Sign in once at `http://127.0.0.1:8788`. In another terminal, grant the local
user admin role while `wrangler dev` keeps running:

```sh
fnm exec bunx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "update \"user\" set role = 'admin' where username = '${GITHUB_USERNAME}';"
```

Create a builder host through the admin Hosts UI, or with the authenticated
browser cookie:

```sh
export INTAR_LIVE_BASE_URL="http://127.0.0.1:8788"
export INTAR_LIVE_COOKIE="better-auth.session_token=..."
curl -sS "${INTAR_LIVE_BASE_URL}/api/agent/hosts" \
  -H "cookie: ${INTAR_LIVE_COOKIE}" \
  -H "content-type: application/json" \
  --data '{"name":"local-kvm-builder","role":"builder"}'
```

Paste the returned `bridgeConfigToml` into `/etc/intar-builder/config.toml` on
the Linux/KVM builder host, keep the `qemu`, `builder`, and `jobs` sections from
`crates/intar-builder/deploy/config.example.toml`, and run:

```sh
export INTAR_REGISTRY_PUBLISH_TOKEN="local-registry-publish-token"
intar-builder doctor --config /etc/intar-builder/config.toml
just bundle-images pair-ping builder.sample.amd64.hcl local-e2e true
intar-builder run-once \
  --config /etc/intar-builder/config.toml \
  --scenario pair-ping \
  --bundle dist/bundles/local-e2e.tar.gz
```

`run-once` is a privileged manual path and publishes through
`/registry/v1/publish` only when `INTAR_REGISTRY_PUBLISH_TOKEN` is set. Daemon
builds instead use the builder host JWT plus the exact active build assignment;
stale or superseded jobs cannot publish. After that, run the live harness
against the same local Worker with `--skip-publish`.

On a non-KVM workstation, use `just render-images` for argument/script inspection
only. A TCG build is useful for diagnosing orchestration but does not satisfy the
release proof.

## Direct Publish Proof

For a local no-upload build that the live harness will publish:

```sh
just build-images broken-nginx builder.sample.amd64.hcl true
```

The build writes a raw-zstd image and manifest under `dist/`, for example:

```text
dist/broken-nginx-webserver-amd64.raw.zst
dist/broken-nginx-webserver-amd64.raw.zst.manifest.json
dist/base-images/trixie-amd64-....vmlinuz
dist/base-images/trixie-amd64-....initrd.img
```

The live harness infers raw image paths from `*.raw.zst.manifest.json` and scans
`base-images/` next to the manifest for kernel/initrd files whose sha256 matches
the manifest boot metadata. If those files live elsewhere, provide comma-separated
`sha256=path` overrides:

```sh
export INTAR_LIVE_ARTIFACTS="<kernel_sha256_hex>=/path/to/vmlinuz,<initrd_sha256_hex>=/path/to/initrd.img"
```

## Run The Proof

Use environment variables so shell history does not capture the cookie or token.

For the fractional-CPU release proof, publish a V3 scenario whose VM contains:

```hcl
cpu = 0.125
vcpus = 1
```

The catalog must report `cpu_millis = 125` and `vcpu_count = 1`. After proving
one busy VM is capped, run eight busy 125-millicore VMs on a host with one
schedulable CPU and verify the ninth reservation is refused.

```sh
export INTAR_LIVE_BASE_URL="https://intar.dev"
export INTAR_LIVE_COOKIE="__Secure-better-auth.session_token=..."
export INTAR_IMAGE_PUBLISH_TOKEN="..."
export INTAR_LIVE_MANIFESTS="$PWD/dist/pair-ping-web-amd64.raw.zst.manifest.json,$PWD/dist/pair-ping-db-amd64.raw.zst.manifest.json"

just live-e2e
```

For a pinned host:

```sh
export INTAR_LIVE_HOST_ID="host-id-from-dashboard"
just live-e2e
```

To add extra forbidden guest-side TCP targets that must not be reachable:

```sh
export INTAR_LIVE_FORBIDDEN_IPS="10.77.99.10,10.77.99.11"
just live-e2e
```

## What It Proves

The harness fails unless all of these are true:

- In direct publish mode, `/registry/v1/publish` accepts the manifest and uploads
  images into R2 after the harness verifies each local `.raw.zst` file's
  compressed SHA-256 against the manifest and logs its byte size.
- In builder mode, `/api/admin/builds` reports the requested bundle revision as
  `succeeded` before the run starts.
- Published manifests and admin scenario metadata use `raw_zstd`, include
  kernel/initrd hashes, advertise a positive virtual size, and direct-boot
  `root=/dev/vda`. The manifest contract is V3 and carries `cpu_millis` plus
  `vcpu_count`.
- The host reports the published image as cache `ready`.
- The V6 bridge reports KVM, nftables, reflink, jailer-v2, hard-quota, Landlock,
  and cgroup-v2 support, with an architecture matching the required images.
- The VM report shows the requested quota/topology, `cpu.stat` usage and
  throttling counters, and healthy sandbox state; the complete process tree is
  in the VM unit/cgroup.
- The two-VM `pair-ping` run starts and reaches terminal-ready inside the
  readiness timeout; the warm-start performance budget remains a separate
  reflink-host gate.
- Run payloads redact unrevealed hint bodies and solution markdown.
- Skip-ahead hint reveal attempts are rejected without mutating reveal state.
- The next hint reveal returns only that hint body and keeps later hints gated.
- The solution body appears only after the explicit solution reveal endpoint.
- A pre-solve solution reveal marks the run as solution-assisted.
- Each VM has a reported SSH host key and gets a browser Stargate route.
- VMs in the same run have distinct generated terminal public keys.
- Guest terminal probes cannot reach link-local metadata over HTTP or the host
  gateway over TCP port 22.
- Same-run peer VM IPs are reachable over TCP port 22.
- Teardown reaches `completed`.
- Fresh terminal session creation and old browser terminal websocket URLs are
  rejected after teardown.
- At least one archived artifact is readable from the Worker/R2 artifact route.
- Every probed VM produces a replay cast containing the probe's executed begin
  and end markers.

The platform permits only one active run per user. Cross-run network isolation
therefore requires a multi-session harness with two authenticated users and
concurrent runs deliberately placed on the same agent host. That proof is outside
this single-session harness; do not claim it from sequential or different-host
runs.

The agent's Kino readiness timeout remains a separate 45-to-360-second bound
scaled from the scenario's steady CPU contract. It does not extend jailerd's
hard boot CPU lease: an admitted v2 VM uses `max(2000m, steady_cpu_millis)` for
at most 45 seconds, after which the root-owned guardian seals it to steady CPU
without exposing SSH. A guest that becomes ready after that seal can finalize
later only after the steady quota is attested. The harness defaults
`--wait-ready-ms` to `480000`, leaving time for desired-state delivery and
report propagation beyond the bounded agent readiness timeout.

The default warm-start budget is `10000` milliseconds. Override only when
diagnosing:

```sh
just live-e2e "--warm-start-ms 15000"
```

## Reproducible Boot-Latency Benchmark

The full live E2E above is a security and lifecycle proof for one run. Use the
dedicated benchmark for promotion latency. It pins every run to one host,
requires the complete fast-launch capability set and an already-ready image,
rejects reused or non-isolated runs, executes five warmups, then records thirty
serial measured boots. An isolation monitor keeps polling the authenticated host
view for the entire owned run, including terminal session creation, the shell
probe, browser reset, and the explicit destroy transition; any attributed or
unattributed foreign VM aborts the benchmark.
Benchmark admission atomically acquires an exclusive host lease with its boot
CPU reservation under the host runtime's serialized D1 boundary. D1 triggers
keep ordinary reservations and scenario re-enablement fail-closed while that
lease exists. The continuous monitor remains an independent runtime proof, and
the result records `atomic_host_lease: true` only after observing the owned
lease throughout the run and its drained release during teardown. Every passed
sample records the first and last owned-lease observations plus the observed
release, and rejects a lease that disappears early or reappears after release.

The runner launches one headless Chromium instance and reuses exactly one
Playwright browser context and page for all five warmups and thirty measured
boots. The primary duration starts immediately before that page clicks the
exact `Start scenario` button. It ends only after the resulting run page renders
its xterm terminal, the terminal status reports `connected`, and `.xterm-rows`
contains the result of a unique command assembled from two marker halves. The
full marker is therefore absent from the echoed input and proves first guest
shell output. This click-to-xterm boundary includes acceptance, desired-state
delivery, guest boot, quota sealing, projection polling, Stargate session
creation, SSH, browser rendering, and first shell output. API polling collects
projection and host evidence but is not a substitute for the browser boundary.
The 100 ms default polling cadence matches the run UI's boot-state cadence.

Run this only on a drained canary host. The host report must show zero committed
CPU and attest KVM, vsock, nftables, reflink, jailer v2, hard quota, boot CPU
lease, template-backed launch, fast template storage, Landlock, and cgroup v2.
`Ready` must mean the raw image, boot artifacts, descriptor, and jail template
are all prepared. The runner freezes the agent version, runtime hash, complete
capability set, desired prewarm set, and actual ready-cache set at preflight and
continuously rejects identity drift or build work through every sample.

Before the boot-quota cutover, disable scenario placement and builder
assignment, drain all active runs/reservations/builds, and stop the old agent
and builder services. Apply
`website/drizzle/0003_boot_cpu_reservation_phases.sql` before deploying the
matching Worker, and do not restart either host role until its matching binary
and readiness checks are in place. This is distinct from the historical
`0001_host_cpu_reservations.sql` V6 migration and is forward-fix-only.
Apply `website/drizzle/0004_host_benchmark_leases.sql` before deploying the
benchmark-admission Worker; it is likewise a breaking, forward-only migration.

For measurement, keep the target agent itself enabled but set its
`scenario_enabled` flag to false. The benchmark uses the explicit admin-only
`admissionMode: "benchmark"` start contract to pin each run to that owned host;
ordinary pinned starts and automatic placement continue to exclude it. The
control plane rejects benchmark admission unless the fresh authoritative host
report has an empty VM inventory and the stored desired state is empty and
fully applied, so a previously admitted VM cannot arrive after preflight.

```sh
bun --cwd website run bench:boot:install

export INTAR_LIVE_BASE_URL=https://intar.dev
export INTAR_LIVE_COOKIE='__Secure-better-auth.session_token=...'
export INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256=DEPLOYED_64_CHARACTER_LOWERCASE_SHA256

just boot-benchmark "\
  --host HOST_ID \
  --variant fully-optimized-current-path \
  --manifest /absolute/path/broken-nginx-webserver-amd64.raw.zst.manifest.json \
  --implementation-sha256 $INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256 \
  --output /absolute/path/optimized.json"
```

Install the Playwright-pinned Chromium revision once on the benchmark host. Set
`INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256` to the canonical 64-character
lowercase SHA-256 identity of the deployed control plane, agent, jailerd, and
rollout configuration; a source commit alone is insufficient when deployment
configuration differs.

The result always records the Cloud Hypervisor SHA-256 attested by the host.
`--cloud-hypervisor-sha256` is only an optional operator cross-check and cannot
replace that attestation. The breaking production runner supports only
`current-2000m-boot-to-1000m-steady` and `fully-optimized-current-path`; for
both, preflight requires the root-owned 2000m boot CPU allocation and 45000ms
hard lease exactly. It refuses to execute the three historical variants and has
no direct-spawn or v1 compatibility path.

The JSON result has `schema_version: 2`, the exact manifest-derived artifact
fingerprint, host and capability evidence, every warmup and measured sample,
generation-fenced quota evidence, report/projection/UI phase timestamps, any
matching-generation host boot phase and five-point CPU samples, exact steady
cgroup quota and one-vCPU evidence, nearest-rank distributions, and the
promotion decision. After the measured browser boundary completes, the runner
waits up to 30 seconds for the periodic matching-generation cgroup report; that
wait is excluded from click-to-usable-terminal latency and never issues a
critical-path `InspectVm`. Missing or inexact evidence fails promotion.
Isolation evidence records the drained benchmark admission
gate and the continuously polled host desired and actual VM inventories,
including unattributed VMs that are not visible through scenario-run
projections. Its
browser evidence records the Playwright and Chromium
versions, headless mode, context/page reuse, and exact measurement boundary.
The comparer requires identical browser versions and boundary metadata across
all five results. Warmups and failures are never included in percentile values,
but any failed boot fails promotion. Promotion requires
exactly five successful warmups, exactly thirty successful measured boots,
an exact 2000m boot-to-1000m steady transition with `cpu.max.burst=0`, one guest
vCPU, matching-generation live quota readback, and complete lease-transition
evidence for every successful boot,
request-acceptance p95 at most 500 ms, usable-terminal p50 at most 7000 ms,
usable-terminal p95 strictly below 10000 ms, and seal-to-projection-to-UI-ready
(`seal_projection_ui_ready_ms`) p95 at most 500 ms. An overridden sample count
remains useful diagnostically but cannot pass the promotion gate.
The final phase metric is a conservative cross-host-clock-safe upper bound: it
subtracts the agent's monotonic boot-start-to-seal-start duration from the
browser's monotonic click-to-render duration. It therefore includes any
click-to-agent dispatch delay and cannot understate the real seal-to-UI time;
wall-clock timestamps remain diagnostic only.

For the five-way same-host comparison, deploy each implementation to the same
drained host in turn and reuse the exact manifest and Cloud Hypervisor hash.
Capture a distinct canonical `implementation_sha256` for each deployed
implementation; the comparer rejects duplicate implementation digests. Use
these exact `--variant` names, one per deployment, in this order. Their CPU
policies are part of the result contract, not labels interpreted after the fact:

1. `pre-jailer-direct`: one guest vCPU and no host-process CPU quota or lease.
2. `exact-jailer-cutover`: one guest vCPU and a steady-only 1000m host-process
   quota.
3. `current-1000m-baseline`: the same steady-only 1000m host-process quota.
4. `current-2000m-boot-to-1000m-steady`: 2000m for at most 45000ms, then 1000m.
5. `fully-optimized-current-path`: the same 2000m-to-1000m lease plus all
   critical-path optimizations.

The comparison requires all five names and refuses different hosts, scenarios,
artifact fingerprints, missing or duplicate implementation digests, missing or
non-host-attested runtime hashes, duplicate labels, different runtime hashes,
browser-version mismatches, measurement-boundary mismatches, or a CPU policy
that does not exactly match the named variant. Variants 1-3 are offline A/B
evidence only: they must be previously captured, same-host schema-v1 result
artifacts with `atomic_host_lease: false` from the corresponding historical
deployments. Only the offline comparer accepts that immutable legacy shape and
recomputes its original promotion contract; the schema-v2 parser and live runner
reject it. Schema v1 is never accepted for either boot-lease variant, and no
code recreates a historical deployment or downgrades production to obtain one.

```sh
just boot-benchmark-compare "\
  --output /absolute/path/boot-ab.json \
  /absolute/path/pre-jailer.json \
  /absolute/path/jailer-cutover.json \
  /absolute/path/jailed-1000m.json \
  /absolute/path/boot-2000m-steady-1000m.json \
  /absolute/path/optimized.json"
```

Cold image/template preparation is intentionally outside these warm samples.
Capture its start time before enabling preparation, then pass it to the run
after the host first reports the image ready:

```sh
just boot-benchmark "\
  --host HOST_ID \
  --variant fully-optimized-current-path \
  --manifest /absolute/path/broken-nginx-webserver-amd64.raw.zst.manifest.json \
  --implementation-sha256 $INTAR_BOOT_BENCH_IMPLEMENTATION_SHA256 \
  --cold-prewarm-started-at-unix-ms PREWARM_START_UNIX_MS \
  --output /absolute/path/optimized.json"
```

The result records the supplied start, the cached-image ready timestamp attested
in the host report, and their duration. A start after the ready timestamp is
rejected. Without the option the result still records that every exact image was
ready before the benchmark and its attested ready timestamp. The benchmark
fails preflight instead of importing or copying an image during a measured
launch.

## Jailed Runtime Risk Checklist

Record these values in the release notes or deployment ticket before retiring
the old self-hosted image builder:

- `intar-builder doctor --config /etc/intar-builder/config.toml` exits 0 on the
  Linux/KVM builder host; attach the printed checklist.
- `sudo -u intar-agent env XDG_CACHE_HOME=/var/cache/intar-agent
  XDG_STATE_HOME=/var/cache/intar-agent/state /usr/local/bin/intar-agent
  --doctor --config /etc/intar-agent/config.toml` exits 0 on the Linux/KVM
  scenario host; attach the printed checklist.
- `sudo /usr/lib/intar/intar-jailerd-self-test` exits 0 on that host; attach its
  jailed-v53 lifecycle, quota, and disposable-state cleanup proof.
- `just build-images broken-nginx builder.sample.amd64.hcl true` on a Linux/KVM
  host emits one `*.raw.zst`, one manifest, and the matching kernel/initrd
  artifacts.
- The built root disk boots with direct `-kernel`/`-initrd` under QEMU/KVM.
- Jailerd hash-verifies, reflinks, and launches the bundled Cloud Hypervisor v53.0
  runtime inside the VM unit and jail; `intar-agent` has no direct spawn path.
- The jailed package smoke test verifies the API-only v53 argv, boots with only
  the allowlisted devices, and independently proves both the inherited
  jailer-installed Landlock boundary and the VM-specific
  `VmConfig.landlock_enable` layer fail closed alongside seccomp.
- A busy `cpu = 0.125`, `vcpus = 1` guest exposes
  `cpu.max = 12500 100000`, `cpu.max.burst = 0`, increments `nr_throttled`, and
  stays within the documented elapsed-time bound after warm-up.
- Eight 125-millicore VMs consume exactly one schedulable CPU; a ninth launch is
  rejected, and every VMM descendant and attributable KVM helper is accounted
  to the correct unit.
- `workshop-cluster` reaches solved state, proving the selected cloud kernel
  carries the k3s modules needed by the scenario.
- The guest reports a larger filesystem after `disk_mib` expansion when the
  requested runtime disk size exceeds the build image size.
- Serial logs still include Intar runtime phases with the quiet published kernel
  cmdline.
- A scenario package that changes `/boot` fails the image build with the kernel
  drift guard.
- The sparse raw-zstd round trip preserves the advertised virtual size and
  restores a sparse raw file on the agent.
- Capture p50 time to Kino ready and the harness-logged compressed image sizes
  for broken-nginx and workshop-cluster.

Useful evidence commands on the Linux/KVM proof host:

```sh
stat -c '%n %s bytes' dist/*.raw.zst
jq -r '.vms[] | "\(.name) virtual=\(.image_virtual_size_bytes) image=\(.image_sha256) kernel=\(.boot.kernel_sha256) initrd=\(.boot.initrd_sha256) cmdline=\(.boot.cmdline)"' dist/*.raw.zst.manifest.json
```

For the deployed production proof, attach the `just live-e2e` output. It prints
the compressed byte count for each uploaded image, the byte count for each
verified kernel/initrd artifact in direct publish mode, the start-acceptance
timing, and the terminal-ready timing used for the warm-start budget. Read the
agent's `vm booted` log fields alongside it to split image lookup, disk staging,
jail/VMM launch, guest readiness, and terminal publication.
