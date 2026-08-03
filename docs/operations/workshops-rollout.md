# Clean-slate multicloud Workshops rollout

This runbook cuts Intar over to the final Workshop schema and deploys the
provider-neutral learner runtime for `agent_kvm`, Hetzner Cloud, and GCP
Compute. It deliberately does not migrate existing D1 data or accept v1
Workshop manifests.

The old web artifact and old D1 database remain an inseparable rollback unit.
The new web artifact reads only the new database.

## Architecture and invariants

```text
browser -> apps/web (only public control-plane Worker)
             |-- D1: generic Workshop/runtime/cost state
             |-- R2: signed checkpoint bundles, recordings, artifacts
             |-- service binding -> intar-provider-hetzner (route-less)
             |-- service binding -> intar-provider-gcp (route-less)
             `-- Stargate -> SSH direct forwarding -> learner IPv4

learner VM -> Debian 13 -> Docker -> Talos-in-Docker -> Kubernetes apps
```

Keep these boundaries intact:

- generic lifecycle code owns authorization, active slots, workspaces,
  generations, guest credentials/reports, progress, routes, recording drain,
  recovery policy, and teardown;
- provider Workers own catalog resolution, provider API calls, idempotency,
  pricing, retry classification, discovery, and deletion confirmation;
- direct-cloud allocations never create synthetic `agent_host` rows;
- Scenarios retain their existing `agent_kvm`/`DesiredVmV2` behavior;
- one learner VM persists during normal Workshop progression;
- only restore or recovery creates a replacement generation;
- checkpoint bundles contain no OCI layers; the guest pulls images by digest;
- no guest application port is public; Stargate forwards declared ports over
  SSH;
- `workshops_enabled` gates the top-level product and
  `workshop_multicloud_runtime_enabled` gates new direct-cloud certification
  and issuance. BYOK connection, inspection, credential rotation, and cost
  forecasting remain available while that flag is off; neither flag stops
  cleanup or reconciliation.

The Platform Engineering Workshop requires 4 vCPU, 16 GiB RAM, and 32 GiB
disk. Its immutable revision contains two exact profiles: Hetzner `cpx42` and
GCP `e2-standard-4` with a 32 GiB `pd-balanced` boot disk in
`europe-west3-a`, then `b`, then `c`. Intar does not resize or substitute either
profile.

## Operator boundary

Production mutations run only through protected GitHub Actions. Do not deploy
Workers, apply D1, create learner resources, or rotate production bindings from
an operator workstation.

Do not use local Docker, Docker Desktop, local VM builders, component-specific
`CARGO_HOME` directories, or keychain automation. The root Bun installation,
shared Bun cache, shared Cargo cache, and root `target/` are the only build
caches. Docker runs only inside provider verifier and learner VMs.

Never print or retain:

- Hetzner project tokens or GCP service-account JSON keys;
- provider KEKs or the GCP catalog API key;
- signing private keys;
- guest bootstrap/report/download capabilities;
- terminal or application cookies;
- Stargate credentials.

## Production identities

| Provider | Worker                   | RPC service              | Durable Object        | secret                               |
| -------- | ------------------------ | ------------------------ | --------------------- | ------------------------------------ |
| Hetzner  | `intar-provider-hetzner` | `HetznerProviderService` | `HetznerConnectionDO` | `HETZNER_PROVIDER_CREDENTIAL_KEK_V1` |
| GCP      | `intar-provider-gcp`     | `GcpProviderService`     | `GcpConnectionDO`     | `GCP_PROVIDER_CREDENTIAL_KEK_V1`     |

Both Workers set `workers_dev: false`, `preview_urls: false`, and have no route.
The web Worker binds them as `HETZNER_PROVIDER_SERVICE` and
`GCP_PROVIDER_SERVICE`. A website-only deployment never redeploys them.

Every provider must return the generated protocol-v1 capability contract:

```ts
capabilities(): {
  protocolVersion: 1;
  providerKind: "hetzner_cloud" | "gcp_compute";
  operations: [
    "resolveProfile",
    "prepareSession",
    "quote",
    "preflight",
    "advanceAllocation",
    "observeAllocation",
    "reboot",
    "advanceDeletion",
    "inspectConnection",
    "rotateCredential",
    "sweep",
  ];
}
```

The web rollout is blocked until a temporary route-less remote probe calls both
deployed services through Cloudflare service-binding RPC and validates that
exact response.

## Protected GitHub configuration

Use separate least-privilege production secrets:

| secret                                  | available to                                                       |
| --------------------------------------- | ------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`                 | protected rollout jobs                                             |
| `CLOUDFLARE_D1_ADMIN_API_TOKEN`         | clean-D1 workflow only                                             |
| `CLOUDFLARE_HETZNER_PROVIDER_API_TOKEN` | Hetzner Worker deployment only                                     |
| `CLOUDFLARE_GCP_PROVIDER_API_TOKEN`     | GCP Worker deployment only                                         |
| `CLOUDFLARE_PROVIDER_PROBE_API_TOKEN`   | route-less capability probe only                                   |
| `CLOUDFLARE_API_TOKEN`                  | web/R2 deployment only                                             |
| `CLOUDFLARE_WEB_ROLLBACK_API_TOKEN`     | exact web-version rollback only                                    |
| `HETZNER_PROVIDER_CREDENTIAL_KEK_V1`    | Hetzner Worker deployment only                                     |
| `GCP_PROVIDER_CREDENTIAL_KEK_V1`        | GCP Worker deployment only                                         |
| `GCP_CATALOG_API_KEY`                   | active GCP Worker deployment only; absent in explicit dormant mode |
| `STARGATE_EGRESS_IPV4_CIDRS`            | web runtime configuration only                                     |

Each KEK is standard-base64 for exactly 32 random bytes. BYOK credentials do
not belong in GitHub; owners submit them through the web application and each
provider Worker envelope-encrypts them.

Set these protected variables before the web cutover:

- `CLEAN_D1_DATABASE_ID` to the UUID returned by the clean-D1 apply workflow;
- `CLEAN_D1_DATABASE_NAME` to `intar-dev-control-plane-v2-20260803-r2`;
- `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEY_ID`;
- `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON` containing public keys only;
- the existing production-review variables required by the web workflow.

Provider KEKs are never passed to Astro build or web deployment jobs. The web
deployment token is never passed to provider jobs.

## 1. Validate the reviewed revision

On the pull request, require Rust, Website, provider Worker, generated-contract,
and browser checks to pass. The repository-level commands are:

```sh
bun install --frozen-lockfile
just check-bootstrap
just check
just test
just build
just check-generated
just check-hydrated
```

`just check-bootstrap` creates a fresh in-memory database, applies the single
baseline, seeds owner/organization plus Scenario, Course, and Workshop
publication state twice, compares the complete state, and checks foreign keys.
It cannot reach production.

The hydrated Platform Engineering manifest must report format 2, eleven
modules, 240 scheduled minutes, 85 slides and 85 note files, a 32,768 MiB
workspace requirement, and both exact runtime profiles. Every OCI image lock
entry must contain a lowercase SHA-256 digest.

Before the clean cutover, disable new issuance in the old control plane and
finish every old cleanup. Retain queries and provider inventories proving all
of the following are zero or absent:

- non-terminal Scenario or Workshop executions and provider allocations;
- active runtime slots, Stargate routes, assist grants, and terminal sessions;
- learner or verifier VMs, servers, instances, disks, addresses, Primary IPs,
  ephemeral SSH keys, and pending provider operations.

Do not make the old D1 database read-only and do not deploy the new web Worker
while an old resource still depends on reconciliation from the old application.
Because the new Worker never reads the old database, cutting over with a live
old resource would orphan its cleanup state.

## 2. Create the clean D1 database

Use `.github/workflows/clean-d1-cutover.yml`; see
[`clean-d1-cutover.md`](clean-d1-cutover.md).

1. Dispatch `plan` on the exact reviewed `main` SHA with confirmation
   `PLAN CLEAN D1`.
2. Review the database inventory and baseline digest artifact.
3. Dispatch `apply` with confirmation `APPLY CLEAN D1`.
4. If the named database already exists, provide its exact expected UUID.
5. Record the new UUID and baseline digest from the retained apply artifact.
6. Set `CLEAN_D1_DATABASE_ID` to that exact UUID and
   `CLEAN_D1_DATABASE_NAME` to `intar-dev-control-plane-v2-20260803-r2`.
7. Verify both protected variables before dispatching any provider or web
   rollout.

The workflow requires exactly one migration,
`apps/web/migrations/0000_clean_multicloud.sql`, applies it to the newly named
database, and verifies the generic allocation, resource, price, and forecast
tables. It does not clear, copy, read, or delete the old database.

Do not manually seed D1 with SQL. After deployment, the owner signs in and
recreates state through authenticated application APIs.

## 3. Deploy providers and web

Provider mutation uses the same protected approval modes as the clean-D1 and
web workflows. Reviewed mode requires administrator bypass disabled, a required
reviewer, and self-review prevention. The explicitly configured single-operator
commissioning mode requires the exact confirmation, protected actor login and
numeric ID, an unexpired window of at most seven days, and an administrator
attestation no more than 15 minutes old. Both modes are restricted to a
first-attempt exact-`main` run and a production deployment policy containing
only `main`. The provider workflow checks the policy at authorization and again
immediately before each provider mutation; the control-plane wrapper forwards
the same single-operator confirmation to providers and web.

Before dispatching the control-plane rollout, capture the complete old rollback
unit in the rollout ticket:

- exact previous `intar-dev` Worker version UUID;
- exact previous D1 name and UUID;
- evidence that the previous Worker version contains that D1 binding;
- the zero-allocation, zero-route, and zero-active-slot evidence above;
- the reviewed source SHA and the clean-D1 plan/apply workflow run IDs.

This evidence is mandatory because the web workflow has no automatic rollback
after a successful `wrangler deploy`. A later scenario-bundle or R2 evidence
step can fail while the new web version is already serving production.

Dispatch `.github/workflows/control-plane-rollout.yml` from the exact reviewed
`main` SHA with:

- provider confirmation `DEPLOY PROVIDER WORKERS`;
- web confirmation `DEPLOY WORKSHOP CONTROL PLANE`;
- the time-bounded sole-operator confirmation only when the protected
  environment is explicitly configured for that commissioning mode;
- when GCP credentials are intentionally deferred, `gcp_dormant=true` and the
  separate exact confirmation `DEPLOY DORMANT GCP PROVIDER`.

Dormant GCP is an explicit protected deployment choice, never a fallback
inferred from a missing `GCP_CATALOG_API_KEY`. The workflow deploys the
route-less `intar-provider-gcp`, validates its service-binding capability
contract, omits the catalog key from its secrets file, and removes a catalog
secret left by a prior active deployment. Its `connect`, `resolve_profile`,
`quote`, `preflight_capacity`, `ensure_foundation`, and `create_instance`
operations fail before token exchange, catalog lookup, or any GCP API call.
Read-only connection inspection, credential rotation, observation, reboot,
deletion, sweeping, and reconciliation remain enabled so switching an activated
provider back to dormant mode cannot orphan existing resources. Inspection and
rotation can recover cleanup visibility or authority but cannot establish a new
connection or issue resources.

The workflow:

1. validates both provider packages independently;
2. deploys each provider with only its own token and secrets;
3. calls both deployed `capabilities()` services through the remote probe;
4. fails closed on any protocol mismatch;
5. builds the Astro web artifact;
6. replaces the fail-closed D1 placeholder only in that artifact;
7. verifies the live clean baseline through the exact new binding;
8. deploys web and publishes the content-addressed workspace-agent/Kino bytes.

Retain the provider capability artifact, Worker versions, web version, guest
tool hashes, new D1 ID, source SHA, and workflow run IDs.

The executable canonical order is therefore: clean-D1 `plan`, clean-D1
`apply`, set and verify both `CLEAN_D1_*` variables, deploy and probe both
provider Workers, then deploy web. Do not dispatch provider or web deployment
against the all-zero D1 placeholder. If the control-plane workflow fails,
inspect whether its web `Deploy` step completed before deciding whether the old
or new compatibility unit is live.

## 4. Bootstrap the empty application

Both Workshop flags remain disabled by default for every organization. The
first-owner bootstrap is a two-step protected-workflow handoff:

1. Run clean-D1 `apply` with the intended owner's exact GitHub login and numeric
   GitHub ID. Retain the successful first-attempt run ID and apply artifact. The
   operation atomically writes the provenance receipt and sole allowlist row.
2. Deploy web, then sign in once through GitHub as that identity. Do not create
   an organization yet.
3. Run clean-D1 `bootstrap-owner` with the same identity, exact new D1 UUID, and
   successful `apply` run ID. It verifies the immutable artifact and the sole
   `github` account binding before granting the administrator role. Sign out and
   in again, then record the resulting Intar user ID and bootstrap artifact.
4. Create the pilot organization while both Workshop flags still default to
   false.
5. Enable `workshops_enabled` only for that exact pilot organization, leaving
   `workshop_multicloud_runtime_enabled` false.
6. Reconnect available provider projects through the owner-only BYOK screens
   and validate their inspection, credential rotation, and cost forecasts while
   `workshop_multicloud_runtime_enabled` is still false. Do not submit a GCP key
   while the GCP Worker is explicitly dormant.
7. Republish the required Scenario and Course catalogs.
8. Hydrate and validate the Platform Engineering Workshop format-v2 bundle.
9. Enable `workshop_multicloud_runtime_enabled` only for that exact pilot
   organization immediately before provider-backed certification and issuance.
   The multicloud flag is not a prerequisite for BYOK or forecasting, and
   cleanup and reconciliation remain active even when issuance is disabled.
10. Publish only after every declared profile certification succeeds, then
    create new sessions. A revision that declares GCP cannot be published while
    the GCP provider remains dormant.

Do not enable either flag globally, and do not target another organization
until the one-user and two-user acceptance evidence below is complete. To stop
new issuance during an incident, remove the pilot's multicloud targeting while
leaving provider cleanup and reconciliation deployed.

Nothing is copied from the prior D1 database. Old users, memberships,
connections, sessions, forecasts, and progress are intentionally absent.

## 5. Connect the Hetzner project

Use one dedicated, initially empty Hetzner project. The owner submits a new
project-scoped read/write token. Intar must:

- inventory the project and reject foreign servers, IPs, firewalls, networks,
  volumes, placement groups, snapshots, or other resources;
- resolve the project currency, locations, Debian 13, `cpx42`, pricing, and
  quota;
- create one persistent SSH-only firewall sentinel;
- envelope-encrypt the token only after validation;
- retain no plaintext token outside the provider Worker request.

Connection policy contains approved locations, concurrency ceiling, optional
session-cost ceiling, and required IPv4. It does not override a Workshop's
machine type.

## 6. Connect the GCP project

The initial GCP live connection and pilot are explicitly deferred and remain
unproven while `intar-provider-gcp` is deployed in dormant mode. Dormant mode is
useful only for build, deployment, service-binding, and capability-contract
proof; it is not proof of catalog access, project validation, allocation, cost,
or teardown.

To activate later, add `GCP_CATALOG_API_KEY` to the protected production
environment and redeploy with `gcp_dormant=false` and without the dormant
confirmation. The protected workflow must pass the explicit Wrangler override
`--var GCP_PROVIDER_MODE:active`; the checked-in configuration and any raw
deploy remain dormant. Only after that deployment and capability probe succeed
should the owner continue with the project connection below. Missing credentials must
fail the non-dormant deployment; they must never select dormant mode implicitly.

Use one dedicated, initially empty GCP project. Enable the required Compute and
billing catalog APIs and grant the dedicated service account only the
permissions needed by the provider contract. The owner submits its JSON key.

Intar must reject foreign Compute resources and must block if the default VPC
still exists. It never deletes that VPC automatically. After validation it
creates the Intar custom-mode VPC, Frankfurt subnet, and persistent SSH-only
firewall sentinel, then envelope-encrypts the JSON key.

The runtime profile resolves the Debian 13 family to an immutable image before
publication. Learner instances have no guest service account, project-wide SSH
keys, IPv6, extra disk, static address, snapshot, image, load balancer, or
public application port.

## 7. Publish and certify both profiles

This stage is blocked until GCP has been activated and connected. Hydration and
format-v2 validation may complete earlier, but publishing the Platform
Engineering revision still requires certification of both declared profiles.

Publication uses one temporary verifier VM for each declared profile. For each
profile, require evidence that the harness:

1. resolved the exact type, image, shape, disk policy, and locations;
2. applied checkpoints cumulatively on the same verifier;
3. ran every named probe after each checkpoint;
4. rebooted and re-verified every checkpoint state;
5. opened all seven declared applications through Stargate;
6. deleted the verifier and confirmed all provider resources absent;
7. stored the signed content-addressed reconstruction bundles;
8. published the immutable revision only after both certifications completed.

The learner does not receive catch-up solutions as ordinary participant
content. Checkpoint bundles and guest tools are signed and generation-bound.

## 8. Forecast before provisioning

Create a draft session by selecting exactly one revision profile and, for
direct cloud, its compatible organization connection. The latest forecast must
be unexpired and below the organization's ceiling before entering the lobby.
Forecast refresh is available while the multicloud feature flag is off. An
explicitly dormant GCP Worker has no catalog key and therefore rejects GCP quote
operations before contacting Google; this does not prevent validating Hetzner
forecasts during the deferred period.

Review all three immutable scenarios:

- expected: lobby provisioning through scheduled end plus ten minutes;
- lease ceiling: lobby provisioning through scheduled end plus lease grace;
- one restore: lease ceiling plus one independently billed 60-minute
  replacement generation.

Hetzner values retain provider net/gross native-currency prices, per-resource
hour rounding, IPv4 cost, and caps. GCP values are public list USD estimates
for compute, `pd-balanced`, and external IPv4 using catalog billing minima and
increments. Do not convert currency or calculate VAT. Traffic, credits,
discounts, negotiated pricing, and invoice adjustments are excluded.

## 9. Run one-user pilots

The dormant rollout cannot start either pilot because the dual-profile Platform
Engineering revision cannot publish until both profiles are certified. After
GCP activation and publication, run the one-user Hetzner `cpx42` session first.
The GCP `e2-standard-4` session remains deferred and unproven until its dedicated
project, connection, certification, and live-test window are available. Then run
the same sequence separately for each provider:

1. check in the owner as a participant and bulk-provision from checkpoint 00;
2. require readiness within 15 minutes;
3. verify the guest reports the pinned generation, SSH host key, terminal,
   probes, and healthy phase;
4. complete core progression on the original VM without allocating a new
   generation;
5. prove Docker, Talos-in-Docker, Cilium/eBPF, terminal recording, and all seven
   applications;
6. compare expected and live estimates to manually rounded resource lifetimes;
7. perform one destructive restore and confirm a new generation and separate
   ledger lines;
8. exercise recovery once, including route revocation and reported work loss;
9. end the session and wait for confirmed provider deletion;
10. compare the final estimate to the recorded resource lifetimes.

For Hetzner, prove deletion of server, Primary IPv4, and ephemeral SSH-key
resources. For GCP, prove disappearance of instance, auto-delete boot disk, and
ephemeral external IPv4. A `cleanup_pending` allocation is a failed teardown,
not a successful pilot.

## 10. Prove two-user isolation

Run a separate session with two enrolled learner workspaces. Prove distinct
executions, generations, provider resources, guest credentials, terminal
sessions, application routes/cookies, recordings, artifacts, and cost-ledger
entries. Cross-user access must fail before reaching Stargate or a provider
service.

End the session and require:

- no active `runtime_provider_allocations` except terminal `deleted` rows;
- every `runtime_provider_resources` row has
  `disappearance_confirmed_at`;
- no pending/running/retryable `runtime_provider_operations`;
- no active runtime slot, Stargate route, or assist grant;
- every server/instance, disk, address/IP, and ephemeral key absent from the
  provider inventories;
- final cost summaries present for both learners.

Only after this evidence may another organization be enabled.

## Evidence checklist

Retain non-secret identifiers and artifacts:

```text
reviewed commit and pull request
validation and production workflow run IDs
clean D1 plan/apply artifacts, name, UUID, and baseline SHA-256
old D1 UUID retained offline
Hetzner and GCP Worker versions and capability response
web Worker version and bound D1 UUID
workspace-agent and Kino SHA-256 values
owner and pilot organization IDs
masked provider connection IDs and project fingerprints
publication, template, revision, profile, certification, and bundle IDs
session, roster, workspace, execution, and generation IDs
provider allocation/resource/operation IDs
forecast versions and price-observation timestamps
route IDs and browser traces for all seven applications
live and final cost estimates with manual calculations
zero-resource and zero-active-slot teardown evidence
first-owner bootstrap mechanism, protected audit ID, and resulting user ID
previous web version UUID and previous D1 binding evidence
```

Successful CI, dormant GCP deployment, or capability probing alone is not GCP
runtime acceptance. Record the GCP pilot as deferred and unproven until a real
allocation and complete teardown evidence exist. Full multicloud acceptance
still requires real allocations and complete teardown evidence for both
providers.

## Rollback

Rollback stops new issuance first but leaves cleanup and reconciliation active.
Confirm or expose every provider resource before switching web versions.

Before dispatch, attach the old compatibility-unit evidence captured before
cutover and fresh evidence showing either that every new provider resource is
deleted or that each remaining resource is explicitly visible as
`cleanup_pending` to the owner. Record whether the failed control-plane run
reached the web `Deploy` step. Never infer the live compatibility unit from the
overall workflow conclusion alone.

Dispatch the `rollback` operation in `.github/workflows/clean-d1-cutover.yml`
with:

- confirmation `ROLLBACK CLEAN D1`;
- issuance-disabled confirmation;
- exact previous web version UUID;
- exact previous D1 UUID.

The workflow verifies that the previous web version contains the previous D1
binding, then deploys that exact existing version at 100 percent traffic. It
waits boundedly until the maintenance fence is absent and the root page is
healthy. The operation does not mutate routes, crons, either D1 database, or
Durable Object lifecycle. It does not run old code against the new database and
does not delete either database. Provider Workers, KEKs, and encrypted
credential state remain available until every cloud resource is confirmed
deleted.

Deleting the old D1, new D1, old Worker identities, credentials, or KEKs is a
separate destructive action that requires explicit confirmation after the
rollback window.
