# Live E2E Proof

This check is the deployed proof required by the refactor plan. It exercises the
Worker, D1 catalog, R2 image registry, host desired-state cache, agent, Stargate,
guest terminal path, network isolation, teardown, and R2 run artifacts.

## Prerequisites

- The website Worker is deployed with the current build.
- For the builder path, at least one Linux/KVM builder host is registered,
  connected, and visible on the admin Builds page.
- At least one Linux/KVM agent host is registered, connected, enabled for
  scenarios, and reporting jailer-v1, hard CPU quota, Landlock, unified
  cgroup-v2 CPU accounting, KVM, nftables, and reflink support.
- `intar-agent --config /etc/intar-agent/config.toml --doctor` exits 0 on that
  agent host.
- `sudo /usr/lib/intar/intar-jailerd-self-test` exits 0 on that host. Doctor is
  read-only; only this artifact-backed root test boots the pinned VMM and
  proves disposable unit/cgroup/jail/network setup, quota, and cleanup.
- You have an authenticated admin browser cookie for the deployed website.
- For direct publish mode, you have the registry publish token and the scenario
  image manifest plus matching kernel/initrd boot artifacts.

## Builder Queue Proof

Use this path for the staging proof after a push to `main`. The Images workflow
uploads a source bundle with revision `${GITHUB_SHA::12}`; the builder downloads
that bundle, builds the raw-zstd image, publishes it, and uploads logs. The live
harness waits for the corresponding admin build rows before starting a run.

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
intar-builder doctor --config /etc/intar-builder/config.toml
just bundle-images pair-ping builder.sample.amd64.hcl local-e2e true
intar-builder run-once \
  --config /etc/intar-builder/config.toml \
  --scenario pair-ping \
  --bundle dist/bundles/local-e2e.tar.gz
```

`run-once` publishes the image through `/registry/v1/publish` using the builder
host JWT. After that, run the live harness against the same local Worker with
`--skip-publish`.

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
- The V6 bridge reports KVM, nftables, reflink, jailer-v1, hard-quota, Landlock,
  and cgroup-v2 support, with an architecture matching the required images.
- The VM report shows the requested quota/topology, `cpu.stat` usage and
  throttling counters, and healthy sandbox state; the complete process tree is
  in the VM unit/cgroup.
- The two-VM `pair-ping` run starts and reaches terminal-ready inside the
  warm-start budget.
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

The default warm-start budget is `10000` milliseconds. Override only when
diagnosing:

```sh
just live-e2e "--warm-start-ms 15000"
```

## Jailed Runtime Risk Checklist

Record these values in the release notes or staging ticket before retiring the
old self-hosted image builder:

- `intar-builder doctor --config /etc/intar-builder/config.toml` exits 0 on the
  Linux/KVM builder host; attach the printed checklist.
- `intar-agent --config /etc/intar-agent/config.toml --doctor` exits 0 on the
  Linux/KVM scenario host; attach the printed checklist.
- `sudo /usr/lib/intar/intar-jailerd-self-test` exits 0 on that host; attach its
  jailed-v53 lifecycle, quota, and disposable-state cleanup proof.
- `just build-images broken-nginx builder.sample.amd64.hcl true` on a Linux/KVM
  host emits one `*.raw.zst`, one manifest, and the matching kernel/initrd
  artifacts.
- The built root disk boots with direct `-kernel`/`-initrd` under QEMU/KVM.
- Jailerd hash-verifies, copies, and launches the bundled Cloud Hypervisor v53.0
  runtime inside the VM unit and jail; `intar-agent` has no direct spawn path.
- The jailed package smoke test boots with only the allowlisted devices and
  proves seccomp and Landlock fail closed.
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

For the staging proof, attach the `just live-e2e` output. It prints the
compressed byte count for each uploaded image, the byte count for each verified
kernel/initrd artifact in direct publish mode, and the terminal-ready timing used
for the warm-start budget.
