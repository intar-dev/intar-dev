---
title: Multicloud Workshops operations
---

This runbook operates the provider-neutral learner runtime for `agent_kvm`,
Hetzner Cloud, and GCP Compute. It covers reviewed production deployment,
provider connection, publication, certification, pilots, and incident response.

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
disk. The first immutable production revision contains the exact Hetzner
`cpx42` profile. GCP remains implemented but operationally deferred; adding
`e2-standard-4` with a 32 GiB `pd-balanced` boot disk in `europe-west3-a`, then
`b`, then `c` creates a later immutable revision after GCP can be certified.
Intar does not resize or substitute either profile.

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

Provider capability probes belong to the provider workflows. They do not block
an unrelated website deployment.

## Protected GitHub configuration

Use protected production secrets. Provider, probe, and web credentials remain
separate; the existing account token intentionally serves D1 migrations,
web/R2 deployment, and protected Flagship targeting:

| secret                                    | available to                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`                   | protected rollout jobs                                             |
| `CLOUDFLARE_HETZNER_PROVIDER_API_TOKEN`   | Hetzner Worker deployment only                                     |
| `CLOUDFLARE_GCP_PROVIDER_API_TOKEN`       | GCP Worker deployment only                                         |
| `CLOUDFLARE_PROVIDER_PROBE_API_TOKEN`     | route-less capability probe only                                   |
| `CLOUDFLARE_API_TOKEN`                    | D1, web, guest-tool R2, and protected Flagship deployment           |
| `ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1`   | active beta-invite link encryption only                             |
| `CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET` | web runtime and maintenance checks                                 |
| `HETZNER_PROVIDER_CREDENTIAL_KEK_V1`      | Hetzner Worker deployment only                                     |
| `GCP_PROVIDER_CREDENTIAL_KEK_V1`          | GCP Worker deployment only                                         |
| `GCP_CATALOG_API_KEY`                     | active GCP Worker deployment only; absent in explicit dormant mode |
| `OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1`       | web activation and protected OIDC ciphertext migration only        |
| `STARGATE_EGRESS_IPV4_CIDRS`              | web runtime configuration only                                     |

Each KEK is standard-base64 for exactly 32 random bytes. BYOK credentials do
not belong in GitHub; owners submit them through the web application and each
provider Worker envelope-encrypts them.

`ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1` is unpadded base64url for exactly 32
random bytes. It encrypts only active, copyable beta invite links. Redeeming or
revoking an invite erases its ciphertext while retaining the hash and audit row.

Platform administrators manage beta access in **People > Beta access**. Create
one fixed seven-day link, then use **Copy** or **Revoke** on its active row. A
link admits one GitHub account. Terminal links and revoked users stay in the
collapsed History section. Restoring a revoked user needs a fresh invite after
cleanup completes; there is no re-invite switch or bootstrap-admin endpoint.
The simplification cutover revokes every older pending or leased link and writes
an `invite.revoked` audit event with reason
`security_simplification_cutover`.

The **Users** tab has no platform-ban control. **Delete** first completes beta
revocation cleanup, then removes sign-in accounts, sessions, memberships, OAuth
grants, and personal SSH keys. The profile is anonymized and hidden while an
opaque tombstone keeps retained workshop and security history valid. Deletion
rejects self-removal, the last active administrator, and a sole organization
owner.

`OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1` is unpadded base64url for exactly 32
random bytes. Normal web deployments bind this runtime secret but never run an
OIDC backfill or cleanup. Use the separate protected
`.github/workflows/oidc-secret-migration.yml` workflow for that lifecycle.

The pinned Wrangler 4.125.0 and Miniflare 5.20260820.0-alpha runtime rejects
`2026-08-23` as a future compatibility date. All Worker configs and the test
pool therefore use the newest accepted date, `2026-08-20`; CI rejects drift.

Keep these protected runtime variables current:

- `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEY_ID`;
- `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON` containing public keys only.

The production D1 name and UUID are explicit resource configuration in
`apps/web/wrangler.jsonc`; they are never an environment-variable override. A
normal deployment keeps that identity stable.

Provider KEKs are never passed to Astro build or web deployment jobs. The web
deployment token is never passed to provider jobs.

## 1. Validate the revision

On a pull request, require the checks that match the changed parts of the
repository. The website lane runs its web contracts, unit and Worker tests,
build, and one Chromium smoke check. The repository-level commands are:

```sh
bun install --frozen-lockfile
just check
just test
just build
just check-generated
just check-hydrated
```

The hydrated Platform Engineering manifest must report format 2, eleven
modules, 240 scheduled minutes, 85 slides and 85 note files, a 32,768 MiB
workspace requirement, and exactly the `hetzner-cpx42` runtime profile for the
first production revision. Every OCI image lock entry must contain a lowercase
SHA-256 digest.

For changes that affect provider lifecycle, deletion, or reconciliation, review
the live provider inventory and the non-terminal allocation and operation rows
before deployment. Never remove provider authority or reconciliation while a
learner, verifier, resource, operation, route, or active slot remains.

## 2. Maintain the production D1 schema

`apps/web/wrangler.jsonc` pins the production database. The TypeScript tables in
`apps/web/src/db/schema/` are its sole schema source of truth; Drizzle Kit owns
the ordered SQL and metadata under `apps/web/migrations/`. After a typed schema
change, run `bun run --cwd apps/web db:generate` and commit all generated SQL
and metadata with the code that uses it. Never hand-edit those files, use a
custom Drizzle migration, add a SQL trigger, run Wrangler's D1 migration
commands, edit a migration ledger, or seed production with workstation SQL.

The website deployment first proves that production is an exact prefix of the
generated migration stream. When a migration is pending, it enables maintenance,
waits 30 seconds for old requests to drain, applies the migration, and verifies
the final schema before reopening. If activation fails after migration,
maintenance stays enabled. Review destructive or narrowing changes as a
separate data-lifecycle operation rather than hiding them in an application
deployment.

## 3. Deploy providers and web independently

Provider mutation keeps its protected reviewed or single-operator approval
mode. The provider workflow validates that mode and its live capability
contract before each provider mutation. It does not deploy the website.

A matching push to `main` starts `.github/workflows/website.yml` automatically.
The run tests and builds the exact commit, runs one Chromium smoke check, and
passes that tested artifact to the production job. The job applies pending D1
migrations, runs one strict `wrangler deploy` for the complete Worker
configuration at 100 percent, proves the active version and bindings, and then
requires stable homepage, favicon, maintenance-probe, and health-API responses.
It does not roll back after a failed activation or live check.

Dispatch `.github/workflows/control-plane-rollout.yml` from the exact reviewed
`main` SHA with:

- provider confirmation `DEPLOY PROVIDER WORKERS`;
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

The provider workflow:

1. validates both provider packages independently;
2. deploys each provider with only its own token and secrets;
3. calls both deployed `capabilities()` services through the remote probe;
4. fails closed on any protocol mismatch.

The web workflow does not rebuild providers, guest tools, or Scenario source
bundles, and it does not run OIDC migration work. Matching guest-tool changes
run `.github/workflows/guest-tools.yml`, which validates and publishes the
content-addressed workspace-agent and Kino artifacts independently. Matching
Scenario and image changes run `.github/workflows/images.yml`, which validates
and publishes the exact source bundle. Retain the web workflow's D1 plan and
verification, deployed Worker version, D1 UUID, source SHA, live-check evidence,
and workflow run ID.

## 4. Operate the pilot organization

Both Workshop flags remain disabled by default for every organization:

1. select the existing pilot organization and record its organization and owner
   IDs;
2. target `workshops_enabled` only to that exact organization, leaving
   `workshop_multicloud_runtime_enabled` false;
3. connect available provider projects through the owner-only BYOK screens and
   validate inspection, credential rotation, and cost forecasts while the
   multicloud flag remains false. Do not submit a GCP key while the GCP Worker
   is explicitly dormant;
4. publish or update the required Scenario and Course catalogs;
5. hydrate and validate the Platform Engineering Workshop format-v2 bundle;
6. enable `workshop_multicloud_runtime_enabled` only for that organization
   immediately before provider-backed certification and issuance;
7. publish only after every declared profile certification succeeds, then
   create new sessions. A revision that declares GCP cannot be published while
   the GCP provider remains dormant.

The multicloud flag is not a prerequisite for BYOK or forecasting, and cleanup
and reconciliation remain active even when issuance is disabled.

Do not enable either flag globally, and do not target another organization
until the one-user and two-user acceptance evidence below is complete. To stop
new issuance during an incident, remove the pilot's multicloud targeting while
leaving provider cleanup and reconciliation deployed.

### Protected organization targeting

Use `.github/workflows/workshop-multicloud-flag.yml`; never change this flag
from a workstation or the Cloudflare dashboard. The workflow has the same
production environment, exact-main, first-attempt, reviewed/single-operator,
and `intar-control-plane-production` serialization fences as the control-plane
rollout. The existing account token in `CLOUDFLARE_API_TOKEN` must preserve its
deployment permissions and additionally have account-level `Flagship Read`,
`Flagship Evaluate`, and `Flagship Write`. Wrangler reads the complete flag
before updating it and the workflow evaluates both the target and non-target
contexts after propagation.

First retain a plan from current `main`:

```sh
gh workflow run workshop-multicloud-flag.yml \
  --repo intar-dev/intar-dev \
  --ref main \
  -f operation=plan \
  -f organization_id=<exact-organization-id> \
  -f expected_current_sha256='' \
  -f confirmation='PLAN WORKSHOP MULTICLOUD FLAG' \
  -f single_operator_confirmation=''
```

Review the retained `plan.json`, both before-evaluation documents, and
`SHA256SUMS`. The only accepted pre-state has a boolean false default and either
no rules or the one exact `organizationId equals <exact-organization-id>` rule.
Any other rule, rollout, organization, default, variation shape, or flag type is
unexpected drift and fails closed. Copy `observedSha256` from the plan artifact
into the apply dispatch:

```sh
gh workflow run workshop-multicloud-flag.yml \
  --repo intar-dev/intar-dev \
  --ref main \
  -f operation=apply \
  -f organization_id=<exact-organization-id> \
  -f expected_current_sha256=<observed-sha256> \
  -f confirmation='TARGET WORKSHOP MULTICLOUD FLAG' \
  -f single_operator_confirmation='SINGLE OPERATOR WORKSHOP CONTROL PLANE'
```

Omit the sole-operator confirmation in reviewed mode. Apply re-reads the flag,
requires the exact plan digest, enables the flag while preserving its false
default, and adds only the exact organization rule without a rollout. It polls
for propagation and retains the before/after definitions, target and non-target
evaluations, recent changelog, run provenance, and verified SHA-256 manifest.
The target evaluation must be true and the control evaluation false.

The workflow treats a non-zero update response as ambiguous rather than proof
that no write occurred. While the job is still running, it always re-reads and
evaluates the canonical state. If the requested state cannot be proved, it
disables the multicloud flag, restores the false default, and clears the
already-exclusive rule set before reporting failure. Evidence is sealed and
uploaded before the final outcome is enforced. Runner loss, force cancellation,
or a job timeout after Cloudflare accepts a write can still bypass this in-job
recovery, so the protected workflow remains the exclusive writer and live flag
state must be verified before issuing or resuming Workshop resources.

To stop new certification and issuance, run a fresh plan, retain its new
`observedSha256`, then dispatch the same workflow with `operation=remove` and
confirmation `REMOVE WORKSHOP MULTICLOUD FLAG`. After proving the pilot rule is
the sole rule, remove replaces the rules with the exact empty set; it does not
disable reconciliation or deletion. Both pilot and control evaluations must be
false afterward. The workflow refuses to touch a flag containing any
additional rule.

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

## 7. Publish and certify every declared profile

The first production revision declares only `hetzner-cpx42`, so it can be
published while GCP remains dormant. Adding `gcp-e2-standard-4` later creates a
new immutable revision, and that revision remains blocked until GCP is active,
connected, and certifiable. No publication may skip one of its declared
profiles.

Publication uses one temporary verifier VM for each declared profile. For each
profile, require evidence that the harness:

1. resolved the exact type, image, shape, disk policy, and locations;
2. applied checkpoints cumulatively on the same verifier;
3. ran every named probe after each checkpoint;
4. rebooted and re-verified every checkpoint state;
5. opened all seven declared applications through Stargate;
6. deleted the verifier and confirmed all provider resources absent;
7. stored the signed content-addressed reconstruction bundles;
8. published the immutable revision only after all declared certifications
   completed.

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

Publish and test the Hetzner-only revision first. The GCP `e2-standard-4`
revision and session remain deferred and unproven until the dedicated project,
connection, certification, and live-test window are available. Run the same
sequence separately for each provider when its revision is published:

1. schedule the sole owner as facilitator with **Learner workspace** selected,
   then check in and bulk-provision that workspace from checkpoint 00;
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
D1 migration log, verification result, name, and UUID
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
previous and activated web version UUIDs and D1 binding evidence
homepage, favicon, maintenance-probe, and health-API evidence
```

Successful CI, dormant GCP deployment, or capability probing alone is not GCP
runtime acceptance. Record the GCP pilot as deferred and unproven until a real
allocation and complete teardown evidence exist. Full multicloud acceptance
still requires real allocations and complete teardown evidence for both
providers.

## Incident response

Stop new certification and issuance first by removing the pilot organization's
multicloud targeting. Leave provider cleanup, reconciliation, KEKs, and
encrypted connection state available until every cloud resource is confirmed
deleted or explicitly visible to the owner as `cleanup_pending`.

If exact web-version activation fails or its result is ambiguous, the deployment
helper restores the previously active version before exiting. Verify the live
version UUID, D1 binding, and root health from the retained activation evidence;
do not infer production state from the overall workflow conclusion. If a fault
appears after activation completed, keep issuance disabled and ship a reviewed
fix through `main` and the protected production workflow. Do not switch Worker
versions, D1 bindings, routes, crons, or Durable Object lifecycle from a
workstation.
