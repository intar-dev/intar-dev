---
title: Live E2E Proof
---

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

Use this path for the deployed production proof after a protected control-plane
rollout from `main`. The serialized website deployment uploads a source bundle
with revision `${GITHUB_SHA::12}` after the new Worker is live; the builder
downloads that bundle, builds the raw-zstd image, publishes it, and uploads
logs. The live harness waits for the corresponding admin build rows before
starting a run.

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
just bundle-images broken-nginx builder.sample.amd64.hcl local-e2e true
intar-builder run-once \
  --config /etc/intar-builder/config.toml \
  --scenario broken-nginx \
  --bundle dist/bundles/local-e2e.tar.gz
```

For a `run-once` check against a local Worker, start the website's local Astro
development server. The builder daemon must be able to reach the
configured `base_url`; `http://127.0.0.1:8788` works only when the development
server and `intar-builder run-once` run on the same Linux/KVM host. If the builder is on a
different machine, bind or tunnel the Worker to an address reachable from that
builder and use that URL in the host config. Create `apps/web/.dev.vars` locally
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

The former local bootstrap recipe applied schema and seeded authorization with
direct Wrangler SQL. It has been retired because that creates a second schema
path and its seed rows no longer satisfy the typed beta-access model. Do not
recreate it. Use the deployed live harness until a typed local bootstrap owns
both Drizzle migration application and beta-access seeding.

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
just bundle-images broken-nginx builder.sample.amd64.hcl local-e2e true
intar-builder run-once \
  --config /etc/intar-builder/config.toml \
  --scenario broken-nginx \
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

The checked-in public proof uses `broken-nginx`. Pass `--scenario` and the
matching manifests explicitly when exercising a separately maintained fixture.

```sh
export INTAR_LIVE_BASE_URL="https://intar.dev"
export INTAR_LIVE_COOKIE="__Secure-better-auth.session_token=..."
export INTAR_IMAGE_PUBLISH_TOKEN="..."
export INTAR_LIVE_MANIFESTS="$PWD/dist/broken-nginx-webserver-amd64.raw.zst.manifest.json"

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
- The selected run starts and reaches terminal-ready inside the readiness
  timeout; the warm-start performance budget remains a separate reflink-host
  gate.
- Run payloads redact unrevealed hint bodies and solution markdown.
- Skip-ahead hint reveal attempts are rejected without mutating reveal state.
- The next hint reveal returns only that hint body and keeps later hints gated.
- The solution body appears only after the explicit solution reveal endpoint.
- A pre-solve solution reveal marks the run as solution-assisted.
- Each VM has a reported SSH host key and gets a browser Stargate route.
- VMs in the same run have distinct generated terminal public keys.
- Guest terminal probes cannot reach link-local metadata over HTTP or the host
  gateway over TCP port 22.
- For a separately supplied multi-VM fixture, same-run peer VM IPs are
  reachable over TCP port 22.
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
- The guest reports a larger filesystem after `disk_mib` expansion when the
  requested runtime disk size exceeds the build image size.
- Serial logs still include Intar runtime phases with the quiet published kernel
  cmdline.
- A scenario package that changes `/boot` fails the image build with the kernel
  drift guard.
- The sparse raw-zstd round trip preserves the advertised virtual size and
  restores a sparse raw file on the agent.
- Capture p50 time to Kino ready and the harness-logged compressed image size
  for broken-nginx.

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
