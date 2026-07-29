# Hetzner BYOK Workshops rollout

This runbook rolls out the Workshops control plane and the Workshops-only
`hetzner_cloud` learner runtime without changing Courses, Scenarios,
organization runners, or `DesiredVmV2`.

The Platform Engineering Workshop uses one direct Hetzner Cloud server per
learner:

```text
Intar website/control plane
  ├─ service binding → route-less intar-hcloud-provider Worker
  │                    └─ encrypted organization BYOK token → Hetzner API
  ├─ signed checkpoint bundle → learner server
  └─ Stargate SSH forwarding → terminal and declared application ports

learner server: Debian 13 → Docker → Talos-in-Docker → Kubernetes applications
```

The immutable Platform Engineering revision requires 4000 millicores, 16 GiB
RAM, and 32 GiB disk and pins the exact x86 server type `cx43`. The resolved
Hetzner shape may provide more disk; the workshop no longer requires a 100 GiB
Intar runner reservation. There is no provider-side server-type substitution.

Container images are not embedded in checkpoint bundles. The bundle contains
`runtime/images.lock`, and the learner server pulls the reviewed external OCI
manifests by SHA-256 digest. The learner therefore needs outbound DNS, TLS, and
HTTPS access to the declared registries.

## Operator boundary

All production deployment mutations run through protected GitHub Actions.
Do not run Wrangler deployment or D1 migration commands from an operator
workstation.

Do not use local Docker or Docker Desktop for this rollout, and do not read,
write, or probe the workstation keychain. Docker is installed and exercised
only inside the trusted builder proof guest and the Hetzner learner servers.
The Hetzner project token is entered once by the organization owner in the
Intar web UI; it is not a GitHub secret, shell variable, ticket attachment, or
builder input.

Read-only `gh`, `curl`, and remote D1 queries are acceptable for evidence.
Never print cookies, bootstrap capabilities, Hetzner tokens, private signing
keys, the provider KEK, or Stargate credentials.

## Hard gates

Keep both feature flags at their default `false` until the dormant deployment
is healthy. Enable only one exact pilot organization while commissioning.

- The pull request's Rust, Website, provider-Worker, generated-contract, and
  browser checks are green.
- Production deployment is from the exact reviewed `main` SHA through
  `.github/workflows/website-deploy.yml`.
- That successful production run retains one immutable GitHub Actions artifact
  containing the exact workspace agent and Kino bytes uploaded to R2, their
  checksums, and the run-bound manifest.
- The production environment is main-only and uses either an independent
  reviewer with prevent-self-review and no administrator bypass, or the
  repository's short-lived single-operator commissioning guard.
- The route-less `intar-hcloud-provider` Worker is deployed with a dedicated
  Cloudflare API token and a valid 32-byte provider credential KEK.
- D1 migrations `0016_hetzner_workshop_runtime.sql` and
  `0017_workshop_checkpoint_guest_tools.sql` are applied exactly once, and
  `PRAGMA foreign_key_check` returns no rows.
- The website has the provider service binding, the Stargate egress CIDRs, and
  the approved runtime-bundle public signing-key map.
- The trusted builder has the matching private Ed25519 seed, a clean Debian 13
  direct-cloud proof disk, and the exact CI-published `intar-workspace-agent`.
  The private seed never enters GitHub, D1, R2, the website Worker, or a learner
  server.
- First-level application routing remains healthy at
  `wa-<opaque-id>.intar.app`; `ws.intar.app` remains unchanged.
- A dedicated, initially empty Hetzner project is connected by an organization
  owner. Intar creates only its persistent sentinel firewall at connection
  time.
- The live Hetzner catalog still reports the pinned `cx43` as non-deprecated,
  x86, and at least 4000 millicores, 16 GiB RAM, and 32 GiB disk.
- A fresh cost forecast is below the configured organization ceiling, or an
  owner has explicitly recorded the session override.
- The one-user pilot ends with confirmed deletion of its server, Primary IPv4,
  and ephemeral SSH key; all cost-ledger resources have deletion timestamps
  and the active slot is released.
- A separate two-user run proves server, route, cookie, credential, and
  organization isolation before the feature is enabled for another
  organization.

The one-user pilot is real launch evidence for one workspace, but it does not
replace the mandatory two-user isolation run.

## Evidence record

Record identifiers and non-secret evidence in the release ticket:

```text
release commit and pull request:
Website validation run:
Website production run:
production guest-tool artifact ID and digest:
clean-base workflow run, artifact ID, and artifact digest:
clean-base proof raw/kernel/initrd SHA-256:
provider Worker deployment/version:
pre-migration D1 Time Travel bookmark:
applied migration IDs:
runtime signing key ID and public-key fingerprint:
builder release tag and checksum:
builder publication/proof log:
pilot organization ID:
Hetzner connection ID and project fingerprint:
sentinel firewall ID:
publication ID, content SHA-256, template ID, revision ID:
session ID:
forecast IDs/versions:
learner workspace and execution IDs:
Hetzner allocation, server, Primary IP, SSH-key, and action IDs:
workspace-application route IDs:
final estimated Hetzner cost and currency:
two-user isolation session ID:
```

Retain screenshots, browser traces, redacted Worker logs, builder logs, and D1
query output. Cost values are provider-native estimates, not invoices.

## 1. Validate the release candidate without local Docker

Run the repository checks that do not invoke Docker:

```sh
just generate-scenario-wasm
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
bun --cwd hcloud-provider-worker install --frozen-lockfile
bun --cwd hcloud-provider-worker run types:cf:check
bun --cwd hcloud-provider-worker run check
bun --cwd hcloud-provider-worker run test
bun --cwd hcloud-provider-worker run build
bun --cwd website install --frozen-lockfile
bun --cwd website run test
bun --cwd website run build
```

Validate and deterministically bundle the reference workshop:

```sh
cargo run -p intar-workshop-cli -- validate workshops/platform-engineering
cargo run -p intar-workshop-cli -- bundle workshops/platform-engineering \
  --output /tmp/intar-platform-engineering-workshop.tar.gz
sha256sum /tmp/intar-platform-engineering-workshop.tar.gz
```

The validator must report 11 modules and 240 scheduled minutes. Confirm the
authoring contract:

```sh
test "$(find workshops/platform-engineering/slides -maxdepth 1 -name 'slide-*.md' | wc -l | tr -d ' ')" = 85
test "$(find workshops/platform-engineering/slides/notes -maxdepth 1 -name 'slide-*.md' | wc -l | tr -d ' ')" = 85
test "$(rg -c '^module "' workshops/platform-engineering/workshop.hcl)" = 11
rg -n 'cpu_millis  = 4000|memory_mib  = 16384|disk_mib    = 32768' \
  workshops/platform-engineering/workshop.hcl
rg -n 'server_type  = "cx43"|system_image = "debian-13"' \
  workshops/platform-engineering/workshop.hcl
rg -n 'Apache-2.0|1b6fad43551a720b143d7a52799f81c4c89455cb' \
  workshops/platform-engineering/workshop.hcl \
  workshops/platform-engineering/SOURCE.md \
  workshops/platform-engineering/LICENSE
```

Regenerate the pinned upstream import with the checked-in importer and require
no diff. Verify every non-comment entry in
`workshops/platform-engineering/runtime/images.lock` uses an
`@sha256:<64 lowercase hex>` reference. A tag-only image reference or an OCI
layer in the runtime bundle is a release blocker.

## 2. Configure protected production inputs

The `production` GitHub environment must allow deployments from `main` only.
Prefer required reviewers, prevent-self-review, and disabled administrator
bypass. If the repository still has exactly one administrator, use
`STARGATE_DEPLOY_APPROVAL_MODE=single-operator` only during a time-boxed
commissioning window:

- pin `STARGATE_SINGLE_OPERATOR_LOGIN` and immutable
  `STARGATE_SINGLE_OPERATOR_ID`;
- set `STARGATE_SINGLE_OPERATOR_EXPIRES_AT` no more than seven days ahead;
- refresh `STARGATE_SINGLE_OPERATOR_ADMIN_ATTESTED_AT` immediately before
  dispatch; it expires after 15 minutes;
- dispatch a new run after a failure; workflow reruns are rejected.

Configure these production secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | account used by the website and provider deployments |
| `CLOUDFLARE_API_TOKEN` | existing least-privilege website/D1/R2 deployment token |
| `CLOUDFLARE_HCLOUD_PROVIDER_API_TOKEN` | dedicated token that can deploy only the route-less provider Worker and its Durable Object |
| `PROVIDER_CREDENTIAL_KEK_V1` | standard-base64 encoding of exactly 32 random bytes |
| `STARGATE_EGRESS_IPV4_CIDRS` | comma-separated IPv4 CIDRs allowed to reach learner TCP/22 |

Configure these production variables:

| Variable | Purpose |
| --- | --- |
| `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEY_ID` | public identifier matching the trusted builder configuration |
| `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON` | JSON object mapping that ID to its canonical base64 32-byte Ed25519 public key |

The builder keeps the corresponding 32-byte Ed25519 private seed in
`/etc/intar/workshop-runtime-ed25519`, owned by `root:intar-builder` with mode
`0640` and exactly one link. The builder accepts that exact root-owned
group-read boundary only when the group matches its non-root primary group,
rejects access ACLs, group write/execute, and every permission for other
users, and therefore lets the unprivileged service read without owning or
replacing the seed. Provision and rotate it separately as root; the installer
never generates or packages private key material and only validates an
existing key. It also rejects foreign members of the `intar-builder` group.
The seed does not belong in GitHub Actions. The GitHub variable contains only
public verification keys. Rotate by adding the new public key first, publishing
and deploying the verifier, moving the builder to the new private seed/key ID,
and retaining old public keys while any immutable revision may still reference
them.

The Hetzner project token is deliberately absent from this table. It is BYOK
data entered in the owner UI and envelope-encrypted by the provider Worker.

## 3. Capture the D1 restore point

These checks are read-only:

```sh
cd website
bunx wrangler d1 time-travel info intar-dev-app-20260709 \
  --config wrangler.jsonc --json

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT id, name, applied_at FROM d1_migrations ORDER BY id;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'PRAGMA foreign_key_check;'
```

Record the [D1 Time Travel][d1-time-travel] bookmark. Do not use Time Travel as
routine rollback: it overwrites D1 and can orphan provider resources, routes,
and R2 artifacts created after the bookmark.

Existing migrations `0004` through `0015` are prerequisites for standalone
workshops and the shared runtime ledger. The Hetzner rollout adds:

| Migration | Purpose |
| --- | --- |
| `0016_hetzner_workshop_runtime.sql` | provider identity, encrypted credential versions, audit events, pinned session provider, signed checkpoint artifacts, guest credentials, Hetzner allocations, provider actual state, immutable forecasts, resource cost ledger, and final cost summaries |
| `0017_workshop_checkpoint_guest_tools.sql` | immutable checkpoint pins for the exact workspace-agent and Kino digests |

Existing execution rows are backfilled to `agent_kvm`. Scenario host
reservations remain agent-only. A Hetzner execution has no synthetic
`agent_host`; its allocation row is the cloud seat, while
`active_runtime_slots` remains global across Scenarios and Workshops.

## 4. Deploy the dormant control plane through CI

Merge only after all pull-request checks are green. A merge does not authorize
a production mutation. Dispatch **Website production** manually from the exact
reviewed `main` SHA:

```sh
gh workflow run website-deploy.yml --ref main \
  -f confirmation='DEPLOY WORKSHOP CONTROL PLANE' \
  -f single_operator_confirmation='SINGLE OPERATOR WORKSHOP CONTROL PLANE'
```

Omit `single_operator_confirmation` in reviewed mode. The website workflow is
the only production orchestrator. It:

1. validates the protected environment and required public/runtime inputs;
2. calls `.github/workflows/hcloud-provider.yml` to test and deploy the
   route-less provider Worker with its KEK;
3. builds the website and statically linked learner
   `intar-workspace-agent`/Kino artifacts;
4. rechecks the protected approval immediately before mutation;
5. publishes content-addressed guest tools to R2;
6. applies D1 migrations;
7. deploys the website Worker with the provider service binding;
8. retains the same guest-tool bytes and their canonical manifest in the
   `production-workshop-guest-tools-<SOURCE_SHA>` Actions artifact;
9. advances and reads back the mutable guest-tool `current.json` as the final
   step, only after D1, the Worker deployment, and retained evidence succeed.

The artifact and final pointer step run only after the preceding production
mutations succeed and are part of the same protected job. A failed or re-run
deployment is not valid builder input. A failure before the final step leaves
only inert content-addressed objects. The final pointer update retries the same
bytes and succeeds only after reading back an exact match. If it cannot attest
the pointer, reconcile `current.json` before dispatching again. Record the
successful run ID and artifact ID/digest; the artifact is retained for 90 days
and is not a long-term release channel.

Directly dispatching **Hetzner provider Worker** validates it but does not
deploy it. Do not run a separate provider mutation or direct Wrangler command
alongside the website workflow.

Watch the production run:

```sh
gh run list --workflow website-deploy.yml --branch main --limit 5
gh run watch <WEBSITE_PRODUCTION_RUN_ID> --exit-status
```

Keep `workshops_enabled` and `workshop_hcloud_runtime_enabled` false throughout
this deployment.

After CI succeeds, prove the migration and binding:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT id, name, applied_at FROM d1_migrations WHERE name IN ('0016_hetzner_workshop_runtime.sql','0017_workshop_checkpoint_guest_tools.sql') ORDER BY id;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'PRAGMA foreign_key_check;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT provider_kind, count(*) AS executions FROM runtime_executions GROUP BY provider_kind ORDER BY provider_kind;"
```

Both migration filenames must appear exactly once, foreign-key check must
return no rows, and all pre-existing Scenario executions must remain
`agent_kvm`.

Run one ordinary Scenario lifecycle after deployment. Its catalog, terminal,
probes, artifacts, desired state, teardown, and active slot must behave as
before. No Scenario may gain an organization provider connection or Hetzner
allocation.

Build the separate clean Debian proof input from the same successful
first-attempt Website production run and exact source SHA:

```sh
gh workflow run workshop-clean-base.yml --ref main \
  -f production_run_id=<WEBSITE_PRODUCTION_RUN_ID> \
  -f confirmation='BUILD WORKSHOP CLEAN BASE' \
  -f single_operator_confirmation='SINGLE OPERATOR WORKSHOP CLEAN BASE'
gh run watch <CLEAN_BASE_RUN_ID> --exit-status
```

Omit the single-operator confirmation in reviewed mode. The protected workflow
uses no Docker daemon or container build. It creates the Debian rootfs with
`mmdebstrap`, boots only a disposable clone with a fresh `INTARBUILD` seed
under KVM, proves Debian 13/x86_64 and SSH readiness, rejects workshop,
Intar-agent, Docker/OCI, Kubernetes, and Talos state, requires acknowledged
QMP shutdown and offline filesystem checks, and then publishes the untouched
source as:

```text
production-workshop-clean-base-<SOURCE_SHA>/
  clean-debian13.raw.zst
  clean-debian13-vmlinuz
  clean-debian13-initrd.img
  package-inventory.txt
  proof.json
  SHA256SUMS
```

The workflow rejects reruns, any existing artifact with the same name, and any
Website run that is not successful, first-attempt, dispatched
from `main`, and at the exact current SHA. Record the clean-base run ID and the
immutable Actions artifact ID/digest. This 90-day artifact is an installation
handoff and retained evidence, not an unversioned image channel.

## 5. Verify first-level workspace application routing

The existing application-routing design remains authoritative:

- public URL: `https://wa-<opaque-id>.intar.app/`;
- one isolated first-level origin per route;
- `ws.intar.app` handles Stargate health and terminal paths;
- `wa-<id>.intar.app` proxies every guest path and method except `CONNECT`;
- the guest port is reached only through SSH direct forwarding;
- no guest, host, or Hetzner application port is public;
- production path-based `/v1/workspace-apps/:route` proxying is disabled.

The checked-in Cloudflare edge state owns:

- a proxied `*.intar.app` CNAME to
  `8cdc5d07-3703-4508-9dc6-3dc861dd560b.cfargotunnel.com` with automatic TTL;
- Tunnel ingress ordered as exact `ws.intar.app`, then `*.intar.app`, then
  final `http_status:404`;
- a final cache-bypass rule for `wa-*.intar.app`.

Exact `ws.intar.app`, `ssh.intar.app`, and `admin.intar.app` records continue
to override wildcard DNS. Do not restore the deeper
`*.workshop-apps.intar.app` design: [Universal SSL][universal-ssl] covers
first-level `*.intar.app`, not that deeper wildcard.

Verify the deployed edge before enabling a pilot:

```sh
curl --fail-with-body --silent --show-error https://ws.intar.app/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://wa-no-such-route.intar.app/
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://garbage.intar.app/
```

The expected results are `200`, `401`, and `404`. A real proxied static
response must show `CF-Cache-Status: DYNAMIC`.

If edge state drifted, use the protected
`.github/workflows/workshop-app-edge.yml` flow from `main`: dispatch
`operation=plan`, review the redacted inventory, then dispatch
`operation=apply` with `confirmation=APPLY WORKSHOP EDGE`. In
single-operator mode also provide
`single_operator_confirmation=SINGLE OPERATOR WORKSHOP EDGE` and refresh the
administrator attestation immediately before each dispatch. Rollback uses
`operation=rollback` and `confirmation=ROLLBACK WORKSHOP EDGE`.

If Stargate drifted, drain terminal and application routes and use
`.github/workflows/stargate-deploy.yml`. Its configuration must retain:

```toml
workspace_app_base_domain = "intar.app"
workspace_app_bootstrap_ttl_seconds = 60
workspace_app_session_ttl_seconds = 900
```

Do not mutate DNS, Tunnel ingress, cache rules, the Stargate binary, its TOML,
or SQLite database manually.

For a real route, require:

- a 60-second, single-use bootstrap capability;
- a `303` that removes the bootstrap query parameter;
- a route-bound `HttpOnly; Secure; SameSite=Lax` host-only cookie with at most
  the configured 900-second session lifetime;
- replay failure with `401`;
- guest cookies with no `Domain`, `Secure` added, and reserved Stargate cookie
  names removed;
- canonical `X-Forwarded-Host`, `X-Forwarded-Proto: https`, and
  `X-Forwarded-Port: 443`, with client-supplied forwarding headers stripped;
- the public route hostname preserved as upstream `Host` unless the immutable
  workshop declaration supplies a validated `upstream_host`; when supplied,
  only upstream `Host` changes and `X-Forwarded-Host` remains the public
  `wa-*` hostname;
- `Cache-Control: private, no-store` and
  `Cloudflare-CDN-Cache-Control: no-store`;
- immediate HTTP and WebSocket failure after explicit route deletion.

Guest paths such as `/healthz`, `/v1/terminal/ws`, and
`/v1/workspace-apps/x` must reach the guest on a `wa-` host rather than
Stargate's gateway router.

## 6. Install and prove the trusted workshop builder

Release `intar-workshop-builder` through `.github/workflows/release.yml` from
the same `main` source SHA as the successful Website production run:

```sh
gh workflow run release.yml --ref main \
  -f project=intar-workshop-builder \
  -f bump=patch \
  -f production_run_id=<WEBSITE_PRODUCTION_RUN_ID>
```

`production_run_id` is mandatory for a new workshop-builder release and must
be empty for every other project. The release verifies through the GitHub API
that the referenced run is the completed, successful, first-attempt
`website-deploy.yml` dispatch from `main` at the exact release source SHA. It
then validates the unique immutable artifact ID/digest and manifest, and copies
those exact workspace-agent and Kino bytes into the builder archive instead of
rebuilding them.

The resulting release payload remains bound to the annotated tag by its
existing release-run, artifact-ID, artifact-name, artifact-digest, and
source-SHA metadata. If publication fails after that tag exists, resume from
the exact tag with `resume_tag` and leave `production_run_id` empty. Resume
restores the tag-bound release payload, including guest-tool provenance,
without depending on the 90-day production artifact. Rerunning the failed new
release job is rejected so it cannot calculate and publish another version:

```sh
gh workflow run release.yml --ref workshop-builder/v<VERSION> \
  -f project=intar-workshop-builder \
  -f bump=patch \
  -f resume_tag=workshop-builder/v<VERSION>
```

Verify the release checksum and install the CI artifact on the dedicated
x86_64 Linux/KVM builder. Do not build or package it with local Docker.

Configure:

- `[worker.runtime_bundle_signing]` with the protected key ID and the
  builder-only private key file;
- `[execution.runtime_bundle_verification]` with a minimal clean Debian 13
  disk, kernel, initrd, boot command line, and their exact SHA-256 values;
- the exact statically linked `intar-workspace-agent` and checksum from the
  workshop-builder release archive, plus its paired Kino binary; their digests
  must match `workshop-guest-tools.provenance.json`, which records the protected
  Website run and immutable artifact ID/digest;
- `[execution.authored_image_preparation]` with the CI-packaged deterministic
  Platform bundle, Kino, sanitizer, their exact checksums, the selected image
  mapping, and an absent atomic output directory;
- the freshly initialized learner-safe workshop `.git` as build material and
  every build-only or known answer path as a forbidden participant path.

The clean direct-cloud proof disk contains only Debian 13 and the `INTARBUILD`
seed/SSH bootstrap contract. It must not contain workshop source, solved state,
pre-pulled OCI layers, or an installed agent copy.

The workshop-builder release archive must contain and pass the included
`deploy/SHA256SUMS` plus the focused checksum files for:

- `intar-workspace-agent`;
- `kino`;
- `deploy/intar-workshop-sanitize`; and
- `platform-engineering-workshop.tar.gz`.

It must also contain `workshop-guest-tools.provenance.json`. Retain that file
with the builder release evidence; do not substitute locally rebuilt guest
tools even if their source tree is identical.

Resolve the current x86_64 workshop builder from the production host inventory;
do not use a hard-coded address or a previous capacity audit. Verify its disk,
CPU, memory, KVM, and active workload state immediately before the rollout.
The selected host may also run scenario workloads: first drain every active
scenario VM and route through the normal control plane, then stop admission,
its privileged socket, and both builders. After verifying the downloaded
release archive checksum, extract it on that host and run:

```sh
sudo systemctl stop intar-agent.service
sudo systemctl stop intar-jailerd.socket
sudo systemctl stop intar-jailerd.service
sudo systemctl stop intar-builder.service
sudo systemctl stop intar-workshop-builder.service
sudo ./deploy/install.sh --check
sudo ./deploy/install.sh
```

`--check` changes nothing. The install mode is idempotent, creates or verifies
the non-login `intar-builder` account and its `kvm` membership, and installs:

- `/usr/local/bin/intar-workshop-builder`;
- the workspace agent, Kino, and sanitizer under
  `/usr/local/libexec/intar`;
- the workshop bundle under `/usr/local/share/intar/workshops`;
- `/etc/intar/workshop-builder.toml`; and
- `/etc/systemd/system/intar-workshop-builder.service`.

It creates the service-owned work roots under
`/var/lib/intar-workshop-builder` with mode `0750`. The cache root is
`root:intar-builder 0750`. The root-owned `clean` child holds the separately
provisioned proof triple and is readable but not writable by the service
account. The separate `authored` child is
`intar-builder:intar-builder 0750`, so the preparer can atomically create its
output without using a group/world-writable parent.

An existing operator-edited config is not replaced. Its bytes are preserved
and its metadata is normalized to `root:intar-builder 0640`. The installer
reloads systemd unit metadata but never enables or starts the service and never
runs `prepare-authored-image`. Review and replace every example token, digest,
and host path before running `doctor`.

Download the exact clean-base artifact from the recorded protected run, verify
its outer Actions artifact identity and inner checksums, then expand and
install it as a separate root-owned input after the installer has created the
`intar-builder` group:

```sh
repository=intar-dev/intar-dev
source_sha=<SOURCE_SHA>
production_run_id=<WEBSITE_PRODUCTION_RUN_ID>
clean_base_run_id=<CLEAN_BASE_RUN_ID>
clean_base_artifact_id=<RECORDED_ARTIFACT_ID>
clean_base_artifact_digest=<RECORDED_SHA256_DIGEST>
clean_base_artifact_name="production-workshop-clean-base-${source_sha}"
run_json="$(gh api \
  "repos/${repository}/actions/runs/${clean_base_run_id}")"
jq -e \
  --arg source_sha "${source_sha}" '
    .event == "workflow_dispatch" and
    .status == "completed" and
    .conclusion == "success" and
    .head_branch == "main" and
    .head_sha == $source_sha and
    .run_attempt == 1 and
    .path == ".github/workflows/workshop-clean-base.yml"
  ' <<<"${run_json}" >/dev/null
artifacts_json="$(gh api \
  "repos/${repository}/actions/runs/${clean_base_run_id}/artifacts?per_page=100")"
jq -e \
  --arg artifact_id "${clean_base_artifact_id}" \
  --arg artifact_digest "${clean_base_artifact_digest}" \
  --arg artifact_name "${clean_base_artifact_name}" '
    .total_count == 1 and
    (.artifacts | length) == 1 and
    (.artifacts[0].id | tostring) == $artifact_id and
    .artifacts[0].name == $artifact_name and
    .artifacts[0].digest == $artifact_digest and
    .artifacts[0].expired == false
  ' <<<"${artifacts_json}" >/dev/null
clean_base_stage="$(mktemp -d)"
chmod 0700 "${clean_base_stage}"
gh run download "${clean_base_run_id}" \
  --repo "${repository}" \
  --name "${clean_base_artifact_name}" \
  --dir "${clean_base_stage}"
(cd "${clean_base_stage}" && sha256sum --check --strict SHA256SUMS)
jq -e \
  --arg repository "${repository}" \
  --arg source_sha "${source_sha}" \
  --arg production_run_id "${production_run_id}" \
  --arg workflow_run_id "${clean_base_run_id}" '
    .schema_version == 1 and
    .repository == $repository and
    .source_sha == $source_sha and
    (.production_run_id | tostring) == $production_run_id and
    (.workflow_run_id | tostring) == $workflow_run_id and
    .workflow_run_attempt == 1 and
    .system_image == "debian-13" and
    .architecture == "x86_64"
  ' "${clean_base_stage}/proof.json" >/dev/null
zstd --decompress --sparse \
  --output "${clean_base_stage}/clean-debian13.raw" \
  "${clean_base_stage}/clean-debian13.raw.zst"
test "$(
  sha256sum "${clean_base_stage}/clean-debian13.raw" | cut -d ' ' -f 1
)" = "$(jq -r .raw_disk_sha256 "${clean_base_stage}/proof.json")"
sudo install -o root -g intar-builder -m 0440 \
  "${clean_base_stage}/clean-debian13.raw" \
  /var/cache/intar-workshop-builder/clean/clean-debian13.raw
sudo install -o root -g intar-builder -m 0440 \
  "${clean_base_stage}/clean-debian13-vmlinuz" \
  /var/cache/intar-workshop-builder/clean/clean-debian13-vmlinuz
sudo install -o root -g intar-builder -m 0440 \
  "${clean_base_stage}/clean-debian13-initrd.img" \
  /var/cache/intar-workshop-builder/clean/clean-debian13-initrd.img
```

Use a private temporary directory in production and remove it after the
installed files and configuration hashes have been verified. Never substitute
a scenario image or locally rebuilt disk for these bytes. Set the
`runtime_bundle_verification` disk hash from `raw_disk_sha256` and the
kernel/initrd hashes from the corresponding entries in `proof.json` before
`doctor`.

On the shared image-builder host, both builder services must remain stopped
with no pending systemd jobs throughout installation. The installer fails
closed if it finds a live legacy builder, workshop builder, QEMU, Cloud
Hypervisor, agent, or jail daemon. Keep `intar-builder.service` drained through
authored-image preparation and the initial checkpoint publication/cold-boot
proof. After those artifacts are safely retained and no builder or QEMU process
remains, restore the existing image builder:

```sh
sudo systemctl start intar-builder.service
```

Do not run the two builder services concurrently. Do not start the
workshop-builder service merely to restore scenario-image build capacity; its
first publication remains the explicit `run-once` operation below.

Install those exact files; do not regenerate the workshop bundle from a mutable
checkout on the host. The Platform image's 32 GiB nominal disk requires a
conservative two-disk peak for construction and later seal/restore work.
Configure `minimum_free_space_bytes = 85899345920` (80 GiB). The current
builder must have at least that much audited free space before the drain; stale
scratch/output caches may be removed only after D1 and host state prove there
are no active builds.

Create a real, non-symlinked, non-group/world-writable output parent that the
`intar-builder` user can write. Then stop publication work and prepare the base
as that unprivileged user:

```sh
sudo systemctl stop intar-workshop-builder.service
sudo -u intar-builder /usr/local/bin/intar-workshop-builder \
  prepare-authored-image --config /etc/intar/workshop-builder.toml
```

The selected output directory must not already exist. Success atomically
promotes `disk.raw`, `provenance.json`, `build.log`, `serial.log`, and
`qemu.log`. Inspect and retain the provenance. It binds the output disk to the
clean disk/kernel/initrd, workshop bundle, Kino, sanitizer, workspace agent,
source tree, bootstrap, image lock, one-commit Git tree, and sole Talos host
image. The command installs no workspace agent into the authored disk.

Before claiming a publication:

```sh
sudo -u intar-builder /usr/local/bin/intar-workshop-builder doctor \
  --config /etc/intar/workshop-builder.toml
```

`doctor` re-hashes the full promoted disk and every pinned preparation input;
do not start the service if it reports provenance drift.

Use `run-once` for the first publication and retain the full direct-proof
serial/build log. For every checkpoint, require both:

1. the existing authored KVM image's sanitize/seal/cold-boot proof; and
2. a fresh clone of the clean Debian disk applying the exact signed
   reconstruction bundle through `intar-workspace-agent verify-bundle`.

The second proof must report
`runtime_bundle_cold_boot_verified = true`. A legacy
`cold_boot_verified = true` alone is insufficient for Hetzner compatibility.
The registry must also pin the CI-published workspace-agent and paired Kino
digests on each immutable checkpoint artifact.

## 7. Enable the exact pilot flags

The Worker binding `FLAGS` uses the Flagship application configured in
`website/wrangler.jsonc`. Create or verify two boolean flags:

- `workshops_enabled`;
- `workshop_hcloud_runtime_enabled`.

For both flags:

- default variant is `false`;
- no broad or percentage rule exists;
- one exact-match rule targets the pilot organization's D1
  `organization.id`;
- matching uses `targetingKey`/`organizationId`;
- only that exact organization receives `true`.

The first flag exposes standalone Workshops. The second authorizes Hetzner
connection, publication resolution, forecasting, provisioning, recovery, and
cleanup. Leave every other organization unmatched.

Disabling the Hetzner flag blocks new provider work, but it is not a teardown
mechanism. Cleanup for an already `cleanup_pending` connection remains
available so a revoked credential can be replaced and external resources can
be deleted.

## 8. Connect the dedicated Hetzner project through the owner UI

Create a dedicated, initially empty Hetzner project. Before connecting, it must
contain no server, Primary IP, firewall, network, volume, placement group,
snapshot, load balancer, floating IP, or SSH-key resource.

Create a project-scoped read/write API token in Hetzner. As the Intar
organization owner, open:

```text
https://intar.dev/organizations/<ORGANIZATION_ID>/workshops
```

Under **BYOK runtime → Hetzner project health**, choose **Connect a dedicated
project** and enter:

- a non-secret display name;
- the read/write token;
- approved location order, default `nbg1, fsn1, hel1`;
- maximum learner servers, default `5`.

Optionally set a gross session ceiling in the project billing currency after
connection. Intar inventories the project, validates Debian 13, locations,
prices, and supported x86 types, creates one persistent firewall sentinel to
prove write access, and only then stores an AES-256-GCM encrypted credential
envelope. The plaintext token must not appear in D1, logs, errors, cloud-init,
guest disks, R2, Stargate, or API responses.

After connection, the project should contain only Intar's sentinel firewall.
Record the connection ID, project fingerprint, currency, approved locations,
server limit, and sentinel firewall ID. Admins may inspect this masked health
state; only owners may connect, rotate, rebind, disconnect, or acknowledge
manual cleanup.

## 9. Publish the immutable CX43 revision

The organization must have an active Hetzner connection before publishing a
Hetzner-declared workshop. Publication re-resolves the exact `cx43` catalog
entry through that project's token and rejects missing, deprecated, ARM,
undersized, or materially changed hardware.

Create a short-lived organization-scoped workshop registry token in the owner
UI or authenticated API, then publish:

```sh
export INTAR_WORKSHOP_REGISTRY_URL=https://intar.dev
export INTAR_WORKSHOP_PUBLISH_TOKEN='<one-time organization token>'
cargo run -p intar-workshop-cli -- publish workshops/platform-engineering
cargo run -p intar-workshop-cli -- status <PUBLICATION_ID>
unset INTAR_WORKSHOP_PUBLISH_TOKEN
```

Do not echo or persist the token. `queued` or `building` is not publication
success. Run the builder once, wait for `published`, then revoke the registry
token.

Verify the immutable result:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT id, organization_id, workshop_slug, content_hash, status, published_revision_id, error FROM workshop_publications WHERE id = '<PUBLICATION_ID>';"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT checkpoint_id, status, sanitized, cold_boot_verified, error FROM workshop_publication_checkpoints WHERE publication_id = '<PUBLICATION_ID>' ORDER BY checkpoint_id;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT checkpoint_id, provider_kind, sha256, signing_key_id, workspace_agent_sha256, kino_sha256, status, cold_boot_verified_at FROM runtime_provider_checkpoint_artifacts WHERE template_revision_id = '<REVISION_ID>' ORDER BY checkpoint_id;"
```

Require 11 checkpoints, all publication checkpoints sanitized and cold-boot
verified, and 11 immutable `hetzner_cloud` artifacts with:

- content SHA-256 and Ed25519 signature;
- the approved signing key ID;
- non-null workspace-agent and Kino SHA-256 values;
- `status = 'verified'`;
- non-null `cold_boot_verified_at`.

Inspect the revision manifest and require 240 minutes, 11 modules, 85 slides,
Apache-2.0 attribution, `cx43`, Debian 13, x86, and resolved hardware satisfying
4000 millicores, 16 GiB RAM, and 32 GiB disk.

## 10. Create the one-user session and approve its forecast

Schedule the session from the immutable revision and select:

```json
{
  "kind": "hetzner_cloud",
  "connectionId": "<CONNECTION_ID>"
}
```

For initial commissioning, the sole organization owner may also be rostered as
the one participant. Ownership supplies management/facilitator controls;
participant membership supplies only that learner's workspace, terminal,
applications, and progress. This does not prove helper consent or two-user
isolation.

The session pins the connection, exact type, resolved hardware, permitted
locations, and initial price observation. Review **Estimated Hetzner cost** and
explicitly choose **Refresh cost** before entering the lobby. Refreshing a
forecast must not create a server, Primary IP, or SSH key.

The immutable forecast must show, in the Hetzner project's native currency:

- per-learner server net/gross;
- per-learner Primary IPv4 net/gross;
- combined per-learner cost;
- participant count;
- expected, lease-ceiling, and one-restore totals;
- preferred and fallback-location assumptions;
- provider tax difference (`gross - net`);
- price observation and expiry;
- exclusions for traffic, credits, promotions, and invoice adjustments.

Forecasts expire after 24 hours and refresh automatically at lobby entry.
Hetzner rounds each independently created resource lifetime up to a full hour.
A restore therefore creates separate server and IPv4 ledger entries with
independent rounding. Do not convert the native billing currency.

If the forecast exceeds the organization gross ceiling, provisioning is
blocked. An owner may record an explicit session override after reviewing the
new price; Intar never substitutes a cheaper server type. Existing learners
are not terminated when live estimates cross the ceiling, but new provisioning
and restores are blocked until override.

## 11. Run the one-user production pilot

Open the lobby, check in the participant, and bulk-provision from
`checkpoint-00`. Confirm that Intar creates exactly:

- one labelled Primary IPv4 with `auto_delete=true`;
- one ephemeral SSH-key resource;
- one `cx43` Debian 13 server attached to the persistent firewall;
- no IPv6, Volume, Network, Backup, snapshot, Load Balancer, Floating IP,
  placement group, or builder server.

The firewall allows inbound TCP/22 only from
`STARGATE_EGRESS_IPV4_CIDRS`. With no outbound rules, the learner can reach the
external registries.

Before routes are enabled, require:

- cloud-init contains only execution identity, Intar's SSH public key,
  control-plane endpoint, and a one-use bootstrap capability;
- the workspace agent consumes the bootstrap once;
- the signed checkpoint is staged in tmpfs, verified, applied, and removed;
- every OCI pull uses a digest present in `runtime/images.lock`;
- the generation-bound agent reports current sequence, phase, SSH host key,
  terminal readiness, probes, and health;
- required probes pass.

Inside the learner server, prove:

- Debian 13 and the pinned toolchain;
- Docker and privileged workloads;
- Talos-in-Docker;
- Cilium/eBPF and kube-proxy absence;
- module 00 and module 01 manual verifiers;
- no facilitator notes, solutions, private signing material, or OCI layer
  bundle;
- one global `active_runtime_slots` row prevents that learner from starting a
  Scenario at the same time.

Exercise all seven declared applications after releasing their modules:

| Application | Guest port |
| --- | ---: |
| Gitea | 30300 |
| Argo CD | 30080 |
| RustFS | 30901 |
| Knative | 31081 |
| Zot | 30500 |
| Cloudbox Console | 30600 |
| Grafana | 30030 |

For each application verify redirects, static assets, guest cookies, uploads,
and WebSocket upgrades where used. No undeclared or learner-selected port may
be routed.

Complete a core module and explain-back. After technical verification latches,
regress one named probe and require completion to remain latched while current
health reports failure; repair it and require health to pass again.

Perform one destructive checkpoint restore:

1. create a post-checkpoint marker and record the current execution, routes,
   allocation, and cost-ledger entries;
2. require explicit confirmation;
3. revoke routes and drain recordings;
4. confirm deletion of the old server, Primary IP, and SSH key;
5. create a new generation from the selected signed canonical bundle;
6. prove the marker is lost while workshop progress and audit history remain;
7. prove the old report credential and stale-generation reports are rejected;
8. prove the new generation has separate provider and cost-ledger resource
   IDs.

Exercise recovery by making the guest report stale: degraded after 45 seconds,
recovery-eligible after 90 seconds, one reboot attempt, then replacement after
the recovery wait if it does not recover. The replacement uses the same pinned
`cx43`; it never mutates the old disk in place or substitutes a type.

## 12. End the session and prove zero external resources

End the session through the facilitator control room. Wait for reconciliation
and confirmed provider deletion; do not disable flags or revoke the Hetzner
token while cleanup is running.

Run read-only D1 checks with the exact session ID:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT allocation.id, allocation.state, allocation.server_id, allocation.primary_ip_id, allocation.ssh_key_id, allocation.deletion_requested_at, allocation.deletion_confirmed_at FROM hetzner_allocations allocation INNER JOIN runtime_executions execution ON execution.id = allocation.execution_id INNER JOIN workshop_workspaces workspace ON workspace.id = execution.domain_id AND execution.domain_kind = 'workshop' WHERE workspace.session_id = '<SESSION_ID>' ORDER BY allocation.created_at;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT ledger.resource_kind, ledger.provider_resource_id, ledger.currency, ledger.provider_created_at, ledger.deletion_confirmed_at FROM runtime_provider_cost_ledger ledger INNER JOIN runtime_executions execution ON execution.id = ledger.execution_id INNER JOIN workshop_workspaces workspace ON workspace.id = execution.domain_id AND execution.domain_kind = 'workshop' WHERE workspace.session_id = '<SESSION_ID>' ORDER BY ledger.provider_created_at, ledger.resource_kind;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS active_slots FROM active_runtime_slots slot INNER JOIN runtime_executions execution ON execution.id = slot.execution_id INNER JOIN workshop_workspaces workspace ON workspace.id = execution.domain_id AND execution.domain_kind = 'workshop' WHERE workspace.session_id = '<SESSION_ID>';"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS stored_routes FROM workshop_workspaces WHERE session_id = '<SESSION_ID>' AND (json_array_length(terminal_route_usernames_json) <> 0 OR json_array_length(application_route_ids_json) <> 0);"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT session_id, currency, final_net_micros, final_gross_micros, forecast_net_variance_micros, forecast_gross_variance_micros, generation_count, restore_count, cleanup_pending_count, manual_cleanup_unverified, finalized_at FROM workshop_session_cost_summaries WHERE session_id = '<SESSION_ID>';"
```

Require:

- every allocation `state = 'deleted'` with non-null
  `deletion_confirmed_at`;
- one server and one Primary IPv4 ledger entry per generation, every one with a
  non-null `deletion_confirmed_at`;
- zero active slots and zero stored terminal/application routes;
- zero active assistance grants and open help requests;
- a finalized cost summary with `cleanup_pending_count = 0`;
- `manual_cleanup_unverified = 0`;
- final net/gross estimates and forecast variance retained in native currency.

Provider IDs remain in D1 as audit evidence; “zero resources” means confirmed
external absence, not deleted ledger rows. In the Hetzner web console, require
no server, Primary IP, or ephemeral SSH key and no unexpected network, volume,
snapshot, backup, load balancer, floating IP, or placement group. The one
persistent Intar sentinel firewall is expected while the connection remains
active.

Query Stargate by the recorded execution IDs and require no terminal,
workspace-application, or browser-session routes. A consumed bootstrap or old
route cookie must fail immediately.

The final value is labelled **estimated Hetzner cost**, not an invoice. Retain
all forecast versions, independent generation ledger entries, final variance,
and restore count.

## 13. Run the mandatory two-user isolation test

Before enabling any additional organization, run a separate session with two
real participant identities in the same pilot organization:

- bulk-provision both from checkpoint 00;
- require two distinct `cx43` servers, Primary IPv4s, SSH keys, workspace-agent
  report credentials, SSH host keys, runtime executions, and active slots;
- require each browser's application cookie to authorize only its own opaque
  route;
- attempt cross-user terminal, application, checkpoint, artifact, and report
  access and require non-enumerable denial;
- open all seven declared applications for both learners;
- delete one learner's route and prove the other remains healthy;
- restore one learner and prove only that learner gains a new independently
  rounded cost generation;
- end the session and repeat every zero-resource and ledger gate from the
  one-user pilot.

Also prove an unrostered organization member and a member of another
organization cannot enumerate the template, session, workspace, application,
cost, or provider connection. A separate helper identity is still required to
prove 15-minute consent, renewal up to 30 minutes, immediate revoke, and
learner-owned terminal/artifact boundaries.

Only after the two-user run and helper-consent evidence are green may another
organization receive exact-match flag rules.

## 14. Expand or stop

To enable another organization:

1. create its dedicated empty Hetzner project;
2. add exact-match `workshops_enabled` and
   `workshop_hcloud_runtime_enabled` rules for that organization;
3. connect its project through its owner UI;
4. publish the source again with that organization's registry token;
5. review a fresh forecast;
6. schedule an explicit organization-member roster.

Never copy connection, credential, template, revision, forecast, allocation, or
ledger rows between organizations.

To stop new issuance, remove or disable the organization's
`workshop_hcloud_runtime_enabled` rule and stop opening new lobbies. Do not
delete the provider Worker, service binding, KEK, encrypted credential
versions, public verification keys, or cost ledger until every allocation is
confirmed deleted.

If a live pilot fails, stop module release, end or cancel through the normal
control plane, and reconcile until the zero-resource gates pass. If the
Hetzner token was revoked, rotate/rebind it through the owner UI and finish
cleanup. `cleanup_pending` is an incident state, not permission to release the
active slot.

Code rollback is a reviewed revert deployed by the same Website production
workflow. Leave additive migrations `0016` and `0017` in place. Never manually
delete provider, credential, allocation, forecast, or ledger rows to make a
gate pass.

Use D1 Time Travel only for confirmed database corruption after all Intar and
Hetzner writes are stopped and external resources are inventoried. Restoring
D1 cannot delete a Hetzner resource; reconcile every recorded provider ID
before reopening the feature.

[d1-time-travel]: https://developers.cloudflare.com/d1/reference/time-travel/
[universal-ssl]: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/
