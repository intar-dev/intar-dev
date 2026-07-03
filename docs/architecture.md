# intar Architecture

This document describes the post-refactor platform shape. The repository is a single
monorepo with shared Rust contracts, a Cloudflare control plane, a KVM host agent,
guest-side Kino probes/recording, a Stargate SSH gateway, image tooling, scenario
content, and mothballed Stardrive cluster tooling that remains testable.

## Repository Layout

- `crates/` is the Rust workspace for `intar-agent`, `kino`, `stargate-*`,
  image tooling, Cloud Hypervisor client code, and shared contract crates.
- `website/` is the Astro and Cloudflare Worker control plane.
- `scenarios/` contains scenario HCL content and base image catalog data.
- `stardrive/` contains the Go cluster tooling retained for maintenance only.
- `.github/workflows/` contains the consolidated Rust, website, image, Stardrive,
  and release workflows.

## Shared Contracts

The platform contracts live in Rust and are generated into TypeScript:

- `intar-kino-proto` owns the Kino probe protobuf and recording constants.
- `intar-contracts` owns bridge, guest runtime, catalog, and Stargate DTOs.
- `intar-contracts-typegen` emits JSON Schema, TypeScript types, constants, and
  contract fixtures into `website/src/generated/`.
- Rust fixture tests and website schema tests validate the same committed fixtures.

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
- The bridge protocol is v5 and full-document based: `client_hello`,
  `server_hello`, `desired_state`, `state_report`, `vm_report`, `build_report`,
  and `sync_request`. Every host declares `role = agent` or `role = builder`.

Run lifecycle state is derived in `website/src/lib/run-lifecycle.ts`. Reports only
advance matching `(run_id, vm_name)` entries, which avoids cross-VM or cross-run
state bleed.

## Image Registry

Scenario pushes upload source bundles instead of building on GitHub Actions. The
bundle endpoint stores a deterministic tar.gz in R2, records content hashes in D1,
and assigns changed scenarios to connected builder hosts.

Builder hosts publish raw zstd artifacts and `ScenarioManifestV2` manifest JSON.
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

`intar-agent` is a reconciler:

- It caches the latest desired-state document in local SQLite so it can converge
  after restart or while temporarily offline.
- It compares desired VMs to local Cloud Hypervisor state and creates, destroys, or
  archives VMs as needed.
- It prewarms raw images and creates per-run root disks with reflink copy when the
  agent data filesystem supports it, falling back loudly to sparse copy.
- It persists VM identity, network details, Kino probe state, SSH host keys, and
  archive jobs locally for crash recovery.

Kino readiness is push-based. Each guest receives `KINO_HOST_READY_PORT` in
`runtime.env`; Kino connects to the host over vsock, streams protobuf probe
snapshots, and includes generated SSH host public keys. The agent persists those
host keys and includes them in VM reports.

## Guest Runtime

Images are provisioned without baked SSH host keys. On first boot the guest
generates host keys, starts `sshd`, and starts Kino. The runtime disk carries:

- per-run authorized SSH public keys,
- Kino vsock coordinates,
- host readiness port,
- hostname,
- guest network address, gateway, and DNS.

Kino still owns in-guest probe execution and shell recording.

## Networking

VM networking is isolated per run:

- The agent allocates a per-run bridge and a `/28` subnet from the configured
  pool, defaulting to `10.77.0.0/16`.
- VMs in the same run can communicate through the run bridge.
- Traffic between runs must route through the host and is dropped.
- The rendered `table ip intar` and `table ip6 intar` nftables ruleset is applied
  as a full text snapshot with `nft -f`.
- Guest egress drops link-local metadata, RFC1918, and CGNAT destinations before
  internet egress is accepted.
- SSH DNAT is constrained to the detected egress interface and, when available, the
  host egress IPv4 address.
- Guest-to-host input is dropped; control traffic uses vsock.

## Mothballed Host Rotation

`stardrive/` and other mothballed VM hosts are retained for maintenance, not as
implicit capacity for the desired-state runtime. Safe rotation is a drain-first
operation:

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

The local `infrastructure/cluster/.env` file is gitignored and must stay
untracked. It may contain root credentials for mothballed Talos infrastructure;
the operator should rotate those credentials before reusing or retiring that
cluster state.

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
- `go test ./...` from `stardrive/`

Release verification also requires a real KVM host proof: publish a scenario,
pre-cache its image, start a run, verify terminal access with the reported host key,
assert metadata/host/cross-run isolation, tear the run down, and confirm artifacts
land in R2.
