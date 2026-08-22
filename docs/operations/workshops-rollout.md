# Multicloud Workshops operations

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
disk. Its immutable production revision contains both exact profiles:
Hetzner `cpx42`, and GCP `e2-standard-4` with a 32 GiB `pd-balanced` boot disk
in `europe-west3-a`, then `b`, then `c`. Intar does not resize or substitute
either profile. Both profiles must certify before this revision can publish.

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

Use protected production secrets. Provider, probe, and web credentials remain
separate; the existing account token intentionally serves D1 migrations,
web/R2 deployment, and protected Flagship targeting:

| secret                                  | available to                                                       |
| --------------------------------------- | ------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`                 | protected rollout jobs                                             |
| `CLOUDFLARE_HETZNER_PROVIDER_API_TOKEN` | Hetzner Worker deployment only                                     |
| `CLOUDFLARE_GCP_PROVIDER_API_TOKEN`     | GCP Worker deployment only                                         |
| `CLOUDFLARE_PROVIDER_PROBE_API_TOKEN`   | route-less capability probe only                                   |
| `CLOUDFLARE_API_TOKEN`                  | D1 migrations, web/R2 deployment, and protected Flagship targeting |
| `HETZNER_PROVIDER_CREDENTIAL_KEK_V1`    | Hetzner Worker deployment only                                     |
| `GCP_PROVIDER_CREDENTIAL_KEK_V1`        | GCP Worker deployment only                                         |
| `GCP_CATALOG_API_KEY`                   | active GCP Worker deployment only; absent in explicit dormant mode |
| `STARGATE_EGRESS_IPV4_CIDRS`            | web runtime; comma-separated canonical Stargate IPv4 `/32` CIDRs   |

Each KEK is standard-base64 for exactly 32 random bytes. BYOK credentials do
not belong in GitHub; owners submit them through the web application and each
provider Worker envelope-encrypts them.

Keep these protected runtime variables current:

- `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEY_ID`;
- `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON` containing public keys only;
- the existing production-review variables required by the web workflow.

The production D1 name and UUID are explicit resource configuration in
`apps/web/wrangler.jsonc`; they are never an environment-variable override. A
normal deployment keeps that identity stable.

Provider KEKs are never passed to Astro build or web deployment jobs. The web
deployment token is never passed to provider jobs.

## 1. Validate the reviewed revision

On the pull request, require Rust, Website, provider Worker, generated-contract,
and browser checks to pass. The repository-level commands are:

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
workspace requirement, and exactly the ordered `hetzner-cpx42` and
`gcp-e2-standard-4` runtime profiles. Every OCI image lock entry must contain a
lowercase SHA-256 digest.

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

The website deployment applies pending migrations through the checked-in
binding, verifies the resulting production schema, and retains the migration
log and verification result before web activation. Each migration must leave
the currently active Worker functional for the short interval before the new
version is activated. Review destructive or narrowing changes as a separate
data-lifecycle operation rather than hiding them in an application deployment.

## 3. Deploy providers and web

Provider mutation uses the same protected approval modes as the web workflow.
Reviewed mode requires administrator bypass disabled, a required
reviewer, and self-review prevention. The explicitly configured single-operator
commissioning mode requires the exact confirmation, protected actor login and
numeric ID, an unexpired window of at most seven days, and an administrator
attestation no more than 15 minutes old. Both modes are restricted to a
first-attempt exact-`main` run and a production deployment policy containing
only `main`. The provider workflow checks the policy at authorization and again
immediately before each provider mutation; the control-plane wrapper forwards
the same single-operator confirmation to providers and web.

Before dispatching the control-plane rollout, record the reviewed source SHA,
currently active `intar-dev` Worker version UUID, and current D1 UUID and
binding. CI uploads an immutable version, proves its exact D1, `SESSION` KV, and
Durable Object bindings, then activates that exact version UUID at 100 percent.
A failed or ambiguous activation restores the exact previously active version
before the job exits.

Routes and crons require the separate trigger deployment command, and Durable
Object lifecycle changes require a regular `wrangler deploy`; neither command
is performed by exact web-version activation. Plan and review those changes as
separate production mutations. A later scenario-bundle step can still fail
after the new web version is already serving production, so inspect the
activation evidence rather than inferring the live version from the overall job
conclusion.

Dispatch `.github/workflows/control-plane-rollout.yml` from the exact reviewed
`main` SHA with:

- provider confirmation `DEPLOY PROVIDER WORKERS`;
- web confirmation `DEPLOY WORKSHOP CONTROL PLANE`;
- the time-bounded sole-operator confirmation only when the protected
  environment is explicitly configured for that commissioning mode;
- `gcp_dormant=false` and an empty dormant confirmation for the active GCP
  rollout.

In reviewed mode, the active dispatch is:

```sh
gh workflow run control-plane-rollout.yml \
  --repo intar-dev/intar-dev \
  --ref main \
  -f provider_confirmation='DEPLOY PROVIDER WORKERS' \
  -f gcp_dormant=false \
  -f gcp_dormant_confirmation='' \
  -f web_confirmation='DEPLOY WORKSHOP CONTROL PLANE' \
  -f single_operator_confirmation=''
```

Configure `GCP_CATALOG_API_KEY` before this dispatch. The active GCP job must
fail if the key is absent. It passes `--var GCP_PROVIDER_MODE:active`; the
checked-in Wrangler configuration remains dormant so a raw deploy cannot start
new GCP work.

Dormant GCP is an explicit protected break-glass choice, never a fallback
inferred from a missing `GCP_CATALOG_API_KEY`. Use `gcp_dormant=true` with the
separate exact confirmation `DEPLOY DORMANT GCP PROVIDER` only when active
GCP work must stay disabled. The workflow deploys the
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
4. calls GCP `readiness()` and, in active mode, requires a successful live
   catalog quote with `readyForNewWork=true`;
5. fails closed on any protocol, mode, or readiness mismatch;
6. builds the Astro web artifact;
7. verifies the permanent D1 and `SESSION` KV bindings in the built artifact;
8. publishes the content-addressed workspace-agent and Kino bytes;
9. applies pending D1 migrations and verifies the production schema;
10. activates the exact immutable web version with automatic previous-version
   restoration on activation failure;
11. queues the exact Scenario source bundle.

Retain the provider capability and readiness artifact, provider Worker versions,
D1 migration and verification artifact, web activation artifact, guest tool
hashes, D1 UUID, source SHA, and workflow run IDs. The executable order is
therefore provider deployment and readiness probing, ordered D1 migrations,
then exact web-version activation.

## 4. Operate the pilot organization

Both Workshop flags remain disabled by default for every organization:

1. select the existing pilot organization and record its organization and owner
   IDs;
2. target `workshops_enabled` only to that exact organization, leaving
   `workshop_multicloud_runtime_enabled` false;
3. connect both dedicated provider projects through the owner-only BYOK screens
   and validate inspection, credential rotation, and cost forecasts while the
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

Use active mode for GCP onboarding. First require retained rollout evidence in
which GCP `readiness()` reports `readyForNewWork=true` and a completed catalog
check. `capabilities()` alone is not sufficient.

Create the `GCP_CATALOG_API_KEY` in a separate administration or FinOps project,
not in a learner-runtime project. The project administrator can create it with
an API-only restriction and write it directly to the protected GitHub
environment secret without printing it:

```sh
export INTAR_GCP_CATALOG_PROJECT_ID='<administration-project-id>'
export INTAR_GCP_CATALOG_KEY_ID='intar-gcp-catalog'

gcloud services enable \
  apikeys.googleapis.com \
  cloudbilling.googleapis.com \
  --project="${INTAR_GCP_CATALOG_PROJECT_ID}"

gcloud services api-keys create \
  --project="${INTAR_GCP_CATALOG_PROJECT_ID}" \
  --key-id="${INTAR_GCP_CATALOG_KEY_ID}" \
  --display-name='Intar GCP catalog' \
  --api-target='service=cloudbilling.googleapis.com' \
  --format='value(name)'

gcloud services api-keys describe "${INTAR_GCP_CATALOG_KEY_ID}" \
  --project="${INTAR_GCP_CATALOG_PROJECT_ID}" \
  --format=json | jq -e '
    (.restrictions.apiTargets // []) as $targets |
    ($targets | length) == 1 and
    $targets[0].service == "cloudbilling.googleapis.com" and
    (($targets[0].methods // []) | length) == 0
  ' >/dev/null

intar_catalog_key_dir="$(mktemp -d)"
intar_catalog_key_file="${intar_catalog_key_dir}/catalog-api-key"
chmod 700 "${intar_catalog_key_dir}"
gcloud services api-keys get-key-string "${INTAR_GCP_CATALOG_KEY_ID}" \
  --project="${INTAR_GCP_CATALOG_PROJECT_ID}" \
  --format='value(keyString)' > "${intar_catalog_key_file}"
chmod 600 "${intar_catalog_key_file}"
test -s "${intar_catalog_key_file}"
gh secret set GCP_CATALOG_API_KEY \
  --repo intar-dev/intar-dev \
  --env production < "${intar_catalog_key_file}"
rm -f -- "${intar_catalog_key_file}"
rmdir -- "${intar_catalog_key_dir}"
unset intar_catalog_key_file intar_catalog_key_dir
```

The `describe` result must contain exactly one API target,
`cloudbilling.googleapis.com`. Do not add another API target. Then run the
active rollout in section 3. Follow Google's
[Cloud Billing Catalog API setup](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api),
[`gcloud services api-keys create` reference](https://docs.cloud.google.com/sdk/gcloud/reference/services/api-keys/create),
and [API-key restriction](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys)
instructions. Do not submit this key through the BYOK screen.

Use one dedicated, initially empty GCP runtime project with billing enabled.
The project owner can prepare it with an authenticated `gcloud` session:

```sh
export INTAR_GCP_PROJECT_ID='<dedicated-project-id>'
export INTAR_GCP_SERVICE_ACCOUNT_ID='intar-workshop-provider'
export INTAR_GCP_ROLE_ID='intarWorkshopProvider'

gcloud services enable \
  cloudasset.googleapis.com \
  cloudbilling.googleapis.com \
  cloudresourcemanager.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com \
  serviceusage.googleapis.com \
  --project="${INTAR_GCP_PROJECT_ID}"

gcloud billing projects describe "${INTAR_GCP_PROJECT_ID}" --format=json
if gcloud compute networks describe default \
  --project="${INTAR_GCP_PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute networks delete default --project="${INTAR_GCP_PROJECT_ID}"
fi
```

The billing response must contain `billingEnabled: true` and a non-empty
`billingAccountName`. Delete the default VPC only in this dedicated empty
project. Intar fails closed when it sees the default VPC or any foreign Compute
resource; it never deletes either one.

Create one custom project role with exactly the provider's active and cleanup
permissions:

```sh
intar_gcp_permissions='cloudasset.assets.searchAllResources,compute.addresses.list,compute.backendServices.list,compute.disks.create,compute.disks.delete,compute.disks.get,compute.disks.list,compute.disks.setLabels,compute.disks.use,compute.firewalls.create,compute.firewalls.get,compute.firewalls.list,compute.forwardingRules.list,compute.globalOperations.get,compute.images.list,compute.instanceGroups.list,compute.instanceTemplates.list,compute.instances.create,compute.instances.delete,compute.instances.get,compute.instances.list,compute.instances.reset,compute.instances.setLabels,compute.instances.setMetadata,compute.instances.setServiceAccount,compute.instances.setTags,compute.machineTypes.get,compute.networks.create,compute.networks.get,compute.networks.getEffectiveFirewalls,compute.networks.getRegionEffectiveFirewalls,compute.networks.list,compute.networks.updatePolicy,compute.networks.use,compute.networks.useExternalIp,compute.projects.get,compute.regionOperations.get,compute.regions.get,compute.routes.list,compute.snapshots.list,compute.subnetworks.create,compute.subnetworks.get,compute.subnetworks.list,compute.subnetworks.use,compute.subnetworks.useExternalIp,compute.targetPools.list,compute.zoneOperations.get,resourcemanager.projects.get,serviceusage.services.list,serviceusage.services.use'

gcloud iam roles create "${INTAR_GCP_ROLE_ID}" \
  --project="${INTAR_GCP_PROJECT_ID}" \
  --title='Intar Workshop Provider' \
  --description='Least-privilege Intar workshop VM lifecycle' \
  --stage=GA \
  --permissions="${intar_gcp_permissions}"

gcloud iam service-accounts create "${INTAR_GCP_SERVICE_ACCOUNT_ID}" \
  --project="${INTAR_GCP_PROJECT_ID}" \
  --display-name='Intar Workshop Provider'

intar_gcp_service_account="${INTAR_GCP_SERVICE_ACCOUNT_ID}@${INTAR_GCP_PROJECT_ID}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "${INTAR_GCP_PROJECT_ID}" \
  --member="serviceAccount:${intar_gcp_service_account}" \
  --role="projects/${INTAR_GCP_PROJECT_ID}/roles/${INTAR_GCP_ROLE_ID}"
```

The list includes the field-level permissions required by the exact instance
insert: instance tags, metadata, labels, and an explicit empty service-account
list, boot-disk labels, and external IPv4 use on both the network and subnet.
It also includes network policy updates required to attach the subnet and
firewall sentinel, plus global and regional effective-firewall reads. Intar
uses those reads to reject an inherited policy that can expose a learner VM to
non-Stargate ingress, block Stargate SSH, or stop required outbound bootstrap
and runtime traffic. Keep the role exact. The provider verifies every project
permission before it stores the credential. Google's
[`instances.insert` reference](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/insert)
and the [`subnetworks.insert`](https://docs.cloud.google.com/compute/docs/reference/rest/v1/subnetworks/insert)
and [`firewalls.insert`](https://docs.cloud.google.com/compute/docs/reference/rest/v1/firewalls/insert)
references are the authority for these field-level requirements. Cloud Asset
Inventory also requires both `cloudasset.assets.searchAllResources` and
`serviceusage.services.use`, as specified by its
[roles and permissions reference](https://docs.cloud.google.com/asset-inventory/docs/roles-permissions).

Create a service-account JSON key only when the organization policy permits
this credential type. Keep the plaintext in a private temporary directory:

```sh
intar_gcp_key_dir="$(mktemp -d)"
intar_gcp_key_file="${intar_gcp_key_dir}/service-account.json"
chmod 700 "${intar_gcp_key_dir}"
gcloud iam service-accounts keys create "${intar_gcp_key_file}" \
  --iam-account="${intar_gcp_service_account}" \
  --project="${INTAR_GCP_PROJECT_ID}"
chmod 600 "${intar_gcp_key_file}"
```

In the owner-only BYOK screen, select GCP Compute, enter the exact project ID,
submit that JSON file, keep the ordered zones `europe-west3-a`,
`europe-west3-b`, and `europe-west3-c`, and set the connection concurrency and
cost limits. After the screen confirms an active connection, remove the local
plaintext file and directory. Do not print, email, upload to GitHub, or retain
the key in an artifact.

```sh
rm -f -- "${intar_gcp_key_file}"
rmdir -- "${intar_gcp_key_dir}"
unset intar_gcp_key_file intar_gcp_key_dir
```

Connection validates project identity, billing, enabled APIs, exact IAM
permissions, quota, the empty inventory, machine type, Debian 13 image family,
zones, the inherent Compute Project asset, and global and regional effective
firewall policy. It then creates the
deterministic Intar custom-mode VPC,
`10.77.0.0/20` Frankfurt subnet, and SSH-only firewall sentinel restricted to
the canonical `/32` values in `STARGATE_EGRESS_IPV4_CIDRS`. Before each VM
create, it also requires the generated subnet route and exactly one untagged,
priority-1000 `0.0.0.0/0` route to the default Internet gateway. A missing or
competing custom route fails closed. Only after all checks succeed does the
provider envelope-encrypt the JSON key.

For credential rotation, create a second key in a new private temporary
directory, submit it through the connection's owner-only rotation action, and
prove that inspection succeeds with the new credential. Only then delete the
old key in GCP by its recorded key ID. Keep at least one working cleanup
credential until all instances, disks, addresses, operations, and reconciliation
rows have terminal deletion evidence.

The runtime profile resolves the Debian 13 family to an immutable image before
publication. Learner instances have no guest service account, project-wide SSH
keys, IPv6, extra disk, static address, snapshot, image, load balancer, or
public application port.

Repository validation and active readiness do not prove a live runtime. GCP
remains operationally unproven until the certification, one-user pilot, and
complete teardown evidence below have all been retained.

## 7. Publish and certify every declared profile

The production revision declares both `hetzner-cpx42` and
`gcp-e2-standard-4`. It remains blocked until both providers are active, their
dedicated projects are connected, and both profiles certify. No publication
may skip, substitute, or defer one of its declared profiles.

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
Forecast refresh is available while the multicloud feature flag is off. Active
GCP readiness and the session forecast must both use the protected catalog key.
An explicitly dormant GCP Worker has no catalog key and rejects GCP quote
operations before contacting Google; a revision that declares GCP cannot
publish in that state.

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

After both certifications succeed, run the same one-user sequence separately
with `hetzner-cpx42` and `gcp-e2-standard-4`. Do not treat the Hetzner run as
evidence for GCP. The GCP path remains unproven until its own live sequence and
teardown complete:

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

Run a separate session with two enrolled learner workspaces for each declared
direct-cloud profile. Prove distinct executions, generations, provider
resources, guest credentials, terminal sessions, application routes/cookies,
recordings, artifacts, and cost-ledger entries. Cross-user access must fail
before reaching Stargate or a provider service.

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
automatic restoration evidence when an activation attempt fails
```

Successful CI, active or dormant GCP deployment, readiness, or capability
probing alone is not GCP runtime acceptance. Record the GCP path as unproven
until a real allocation and complete teardown evidence exist. Full multicloud
acceptance requires real allocations and complete teardown evidence for both
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
