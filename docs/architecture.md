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
- The bridge protocol is v4 and full-document based: `client_hello`,
  `server_hello`, `desired_state`, `state_report`, `vm_report`, and
  `sync_request`.

Run lifecycle state is derived in `website/src/lib/run-lifecycle.ts`. Reports only
advance matching `(run_id, vm_name)` entries, which avoids cross-VM or cross-run
state bleed.

## Image Registry

Scenario builds produce qcow2 artifacts and `ScenarioManifestV1` manifest JSON.
The publish endpoint verifies manifests and image hashes, stores immutable images in
R2, seeds the D1 scenario catalog, and updates each host desired-state document with
the referenced cached images.

Agents list and download images through the Worker registry endpoint. The agent
cache validates hashes fail-closed, keeps qcow2 files by image key, pre-converts
warm images to `<sha256>.raw`, and reports cache readiness from the raw artifact.

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
