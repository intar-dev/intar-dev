# intar Architecture

This document describes the post-refactor platform shape. The repository is a single
monorepo with shared Rust contracts, a Cloudflare control plane, a KVM host agent,
guest-side Kino probes/recording, a Stargate SSH gateway, image tooling, scenario
content, and the desired-state runtime that connects those components.

## Repository Layout

- `crates/` is the Rust workspace for `intar-agent`, `kino`, `stargate-*`,
  image tooling, Cloud Hypervisor client code, and shared contract crates.
- `website/` is the Astro and Cloudflare Worker control plane.
- `scenarios/` contains scenario HCL content and base image catalog data.
- `.github/workflows/` contains the consolidated Rust, website, image, and release
  workflows.

## Shared Contracts

The platform contracts live in Rust and are generated into TypeScript:

- `intar-kino-proto` owns the Kino probe protobuf and recording constants.
- `intar-contracts` owns bridge, guest runtime, catalog, and Stargate DTOs.
- `intar-contracts-typegen` emits JSON Schema, TypeScript types, constants, and
  contract fixtures into `website/src/generated/`.
- Rust fixture tests and website schema tests validate the same committed fixtures.

The jailer cutover is coordinated and intentionally incompatible. Catalog
manifests are V3. The bridge envelope is V6 and carries V2 desired-state,
resource/capacity, state-report, and VM-report documents. Old V2 catalog and V5
bridge documents are rejected instead of translated.

## Control Plane

The website Worker is also the control plane. Durable Objects keep host WebSocket
connections warm, D1 stores desired and actual state, and R2 stores immutable VM
images plus run artifacts.

Host orchestration is desired-state based:

- `host_desired_state` stores the full per-host target document.
- `host_actual_state` stores the latest full host report.
- Desired VMs are keyed by `(run_id, vm_name)`.
- Desired phases are only `running` and `absent`.
- Image build assignments are keyed by `build_id` and delivered in the same
  desired-state document under `builds`.
- The bridge protocol is v6 and full-document based: `client_hello`,
  `server_hello`, `desired_state`, `state_report`, `vm_report`, `build_report`,
  and `sync_request`. Every host declares `role = agent` or `role = builder`.
  Agent capacity reports total, reserved, schedulable, and committed host
  millicores plus jailer, hard-quota, Landlock, and cgroup-v2 capabilities.

Run lifecycle state is derived in `website/src/lib/run-lifecycle.ts`. Reports only
advance matching `(run_id, vm_name)` entries, which avoids cross-VM or cross-run
state bleed.

`website/drizzle/0000_baseline.sql` describes a fresh control plane. The jailer
cutover adds `0001_host_cpu_reservations.sql`; the per-host runtime Durable
Object serializes pending and committed CPU reservations so concurrent starts
cannot overcommit a host.

## Image Registry

Scenario pushes upload source bundles instead of building on GitHub Actions. The
bundle endpoint stores a deterministic tar.gz in R2, records content hashes in D1,
and assigns changed scenarios to connected builder hosts.

Builder hosts publish raw zstd artifacts and `ScenarioManifestV3` manifest JSON.
The publish endpoint verifies manifests and image hashes, stores immutable images
in R2, seeds the D1 scenario catalog, and updates each agent desired-state document
with the referenced cached images.

Agents list and download images through the Worker registry endpoint. The agent
cache validates compressed raw-zstd hashes fail-closed, decompresses sparse raw
files to `<sha256>.raw`, and reports cache readiness from the raw artifact.

## Builder Daemon

`intar-builder` is a dedicated image-build reconciler:

- It joins the same bridge as agents with `role = builder`.
- It caches the latest desired-state document in local SQLite.
- It consumes `DesiredBuildV1` assignments, fetches the source bundle, and
  recomputes content hashes before building.
- It reports each phase through `build_report`; terminal reports remove the build
  from desired state.
- It uploads build logs to R2 for the admin builds page.
- The HostRuntime alarm requeues assigned builds from builders that have been
  disconnected for 10 minutes and marks building jobs stale after 30 minutes
  without a build report.

Builder hosts are never selected for scenario runs. The admin host onboarding flow
creates them with `scenario_enabled = false`, and the scheduler only assigns image
builds to connected, non-disabled builder hosts whose reported architecture matches
the desired build.

## Host Agent

`intar-agent` is an unprivileged reconciler:

- It caches the latest desired-state document in local SQLite so it can converge
  after restart or while temporarily offline.
- It compares desired VMs with typed jailerd inspection results and requests
  launch, stop, destroy, and run-network operations as needed.
- It prewarms raw images and creates per-run root disks with reflink copy when the
  agent data filesystem supports it, falling back loudly to sparse copy.
- It persists VM identity, network details, Kino probe state, SSH host keys, and
  archive jobs locally for crash recovery.

The agent never spawns Cloud Hypervisor, invokes a privileged shell, or mutates
TAPs, bridges, routes, nftables, namespaces, cgroups, or device policy. Its
service has an empty capability bounding set and requires no `kvm` or `netdev`
membership. It sends bounded typed requests to the root-owned
`/run/intar-jailerd/control.sock` instead.

## Scenario CPU resources

Scenario HCL uses exact fixed-point CPU ceilings:

```hcl
cpu = 0.125
# Optional; defaults to ceil(cpu), minimum 1.
vcpus = 1
```

Positive integer or decimal literals with at most three fractional digits are
accepted. `0.125` becomes 125 millicores and `2` remains 2000 millicores;
zero, exponent notation, excess precision, and
`cpu_millis > vcpu_count * 1000` are rejected. `cpu_millis` is the aggregate
systemd/cgroup-v2 hard ceiling for the complete VMM process tree, while
`vcpu_count` controls guest topology. It is also the unit used for local and D1
admission reservations.

`intar-jailerd` reserves 1000 host millicores by default and is the final local
admission authority. For a fixed 100 ms period, 125 millicores is
`cpu.max = 12500 100000` with `cpu.max.burst = 0`; eight such VMs consume one
schedulable core exactly.

Kino readiness is push-based. Each guest receives `KINO_HOST_READY_PORT` in
`runtime.env`; Kino connects to the host over vsock, streams protobuf probe
snapshots, and includes generated SSH host public keys. The agent persists those
host keys and includes them in VM reports. The launch deadline treats 45 seconds
as a one-core CPU-time budget and scales wall time as
`ceil(45 * 1000 / cpu_millis)`, bounded to 45–360 seconds. A 125-millicore VM
therefore gets up to 360 seconds to complete its first boot without relaxing its
hard CPU ceiling. The generated guest supervisor gives `sshd` 120 seconds from
the start of its activation, measured against Linux's monotonic uptime instead
of a fixed retry count. That covers the quota-scaled 80-second equivalent of the
old ten-second budget with 50% headroom. This caps the SSH phase at one third of
the 360-second agent deadline; earlier and later first-boot work shares the same
whole-runtime deadline. Readiness is only accepted after the queued nonblocking
SSH start job has drained. Image finalization disables both SSH service aliases,
masks socket activation, and gates `ssh.service` on `/run/intar/ssh-ready` before
removing baked host keys. On first boot the supervisor configures networking and
access, generates and validates the keys, creates the root-only gate, and then
explicitly starts `ssh.service`. Image content hashes use build format
`intar-image-build-v6`, ensuring images with bounded first-boot network-device
discovery and failure diagnostics are rebuilt rather than reused.

## Guest Runtime

Images are provisioned without baked SSH host keys. On first boot the guest
generates host keys, starts `sshd`, and starts Kino. The runtime disk carries:

- per-run authorized SSH public keys,
- Kino vsock coordinates,
- host readiness port,
- hostname,
- guest network address, gateway, and DNS,
- same-run peer VM names and addresses.

The supervisor installs the peer entries into `/etc/hosts` (and maps the VM's
own hostname to its run-network address), so every VM in a run resolves every
other VM by its scenario VM name. Peer addresses are also exported to login
shells as `INTAR_PEER_<VM>_IP`.

Kino still owns in-guest probe execution and shell recording.

## Networking

VM networking is isolated per run:

- The agent allocates addresses from the configured pool, defaulting to
  `10.77.0.0/16`, and sends the complete topology in a typed request. Jailerd
  independently restricts requests to canonical per-run `/28`s inside its
  root-owned matching pool and refuses to replace unrelated host routes.
- Jailerd creates one network namespace per run, its bridge, every VM TAP, and
  the veth/transit connection to the host. The TAP is owned by the VM identity.
- VMs in the same run can communicate through the run bridge.
- Traffic between runs must route through the host and is dropped.
- Jailerd applies the required routes and nftables state; the agent has neither
  `CAP_NET_ADMIN` nor `CAP_NET_RAW`.
- Guest egress drops link-local metadata, RFC1918, and CGNAT destinations before
  internet egress is accepted.
- SSH DNAT is constrained to the detected egress interface and, when available, the
  host egress IPv4 address. Public ports must be inside jailerd's root-owned
  configured range and are reserved globally across active and recovered VMs.
- Guest-to-host input is dropped; control traffic uses vsock.

## Host Rotation

Agent and builder host rotation is a drain-first operation:

- Disable scenario scheduling on the host before changing cluster membership or
  host identity.
- Wait for desired VMs and image build assignments to leave the host's desired
  state, then confirm actual state reports no live VMs or active builds.
- Preserve local agent state until every VM has either archived successfully or
  been intentionally abandoned; reflink root disks depend on their cached base
  image while the local VM exists.
- Rotate one host at a time so run bridges, Stargate routes, and host-reported SSH
  keys remain attributable during teardown and artifact upload.

If those conditions cannot be proven, treat rotation as destructive maintenance
and expect active runs on that host to fail.

The V3/V6 jailer rollout is always destructive maintenance because existing
unsandboxed VMs cannot be adopted. Drain every run and stop old agents first;
install jailerd, jailer, the pinned Cloud Hypervisor v53.0 runtime, and systemd
units while agents remain stopped; apply the D1 reservation migration and
deploy the V6 Worker; republish every V3 manifest; then start only hosts that
pass agent doctor and the root-only jailerd self-test. Validate a real
`cpu = 0.125` run and the eight-VM saturation case before re-enabling starts.

## Terminal Access

The Worker creates an Ed25519 keypair for each `(run, vm)` launch. The public key is
placed in the desired VM document and guest runtime disk. The private key is stored
encrypted in D1 and is supplied to Stargate only when issuing a terminal session.

Stargate uses `russh` in process:

- Browser terminal sessions bridge directly to the target SSH channel.
- Native sessions authenticate the user to Stargate with profile SSH keys, then
  Stargate connects to the guest with the run-scoped private key.
- Guest SSH host keys are verified against the keys reported by Kino; missing or
  mismatched host keys fail closed.

## Verification Gates

Local verification should include:

- `cargo test --workspace`
- `bun --cwd website test`
- `bun --cwd website run build`

Scenario-host release readiness additionally requires both distinct gates:

- `sudo -u intar-agent env XDG_CACHE_HOME=/var/cache/intar-agent
  XDG_STATE_HOME=/var/cache/intar-agent/state /usr/local/bin/intar-agent
  --doctor --config /etc/intar-agent/config.toml` is read-only and runs with
  the same XDG paths and peer identity as the deployed service.
- `sudo /usr/lib/intar/intar-jailerd-self-test` boots the pinned VMM, measures
  its hard quota, and removes disposable privileged state; it is the
  operational proof. Use `--offline` after pre-seeding its pinned cache.

Release verification also requires a real KVM host proof: publish a scenario,
pre-cache its image, start a run, verify terminal access with the reported host key,
verify metadata HTTP is unreachable, the host gateway rejects guest SSH, and
same-run peers can reach each other over SSH; then tear the run down and confirm
archive and replay artifacts land in R2.

See [Scenario Host Jailer](scenario-host-jailer.md) for the root-owned config,
pinned runtime/hash, readiness boundary, and ordered cutover.
