# Provider Worker rollout

Hetzner and GCP are built with the Astro application but deployed as independent
route-less Workers. A web-only change does not deploy either provider.

Production identities:

| Provider | Worker | RPC entrypoint | Durable Object | KEK |
| --- | --- | --- | --- | --- |
| Hetzner | `intar-provider-hetzner` | `HetznerProviderService` | `HetznerConnectionDO` | `HETZNER_PROVIDER_CREDENTIAL_KEK_V1` |
| GCP | `intar-provider-gcp` | `GcpProviderService` | `GcpConnectionDO` | `GCP_PROVIDER_CREDENTIAL_KEK_V1` |

The web Worker binds them as `HETZNER_PROVIDER_SERVICE` and
`GCP_PROVIDER_SERVICE`. Provider configs set `workers_dev: false`,
`preview_urls: false`, and declare no routes.

## Deployment gate

Provider mutations use the same protected approval modes as the web workflow.
In `reviewed` mode the production environment must disable
administrator bypass, require at least one reviewer, and prevent self-review;
the single-operator confirmation must be empty. In the explicitly configured
`single-operator` commissioning mode, the dispatch must include
`SINGLE OPERATOR WORKSHOP CONTROL PLANE` and match the protected GitHub login
and numeric user ID. Its expiry must be in the future and at most seven days
away, and the protected administrator attestation must be no more than 15
minutes old. Both modes require a first-attempt run from exact `main` and an
environment deployment policy containing only the `main` branch.

The provider workflow evaluates this policy once before authorizing the
deployment and again immediately before each Hetzner and GCP mutation. A direct
provider dispatch supplies `single_operator_confirmation` itself. The protected
control-plane wrapper forwards its identically named input to both provider and
web workflows.

The canonical production order is:

1. merge the exact reviewed revision to `main` and verify that
   `apps/web/wrangler.jsonc` still pins the intended production D1 database;
2. dispatch `.github/workflows/control-plane-rollout.yml`, which deploys and
   probes both provider Workers before invoking web deployment;
3. retain the provider capability and readiness, D1 migration, and exact
   web-version activation evidence, then verify the public control plane.

The web workflow applies the ordered D1 migration stream before activating the
new immutable Worker version. A failed or ambiguous activation restores the
previously active version before the job exits. Do not deploy a provider as a
workaround for a web or D1 failure, and never patch the production D1 binding
from a workstation or a GitHub environment variable.

For a provider-affecting change, `.github/workflows/provider-workers.yml`
installs the single root Bun workspace, runs package and provider conformance
tests, builds both route-less Workers, and can deploy either Worker independently.
The protected `.github/workflows/control-plane-rollout.yml` deploys both provider
Workers before invoking the web deployment. A regular web deployment performs
the same capability-contract gate but never redeploys a provider.

Direct production dispatches of `provider-workers.yml` share the
`intar-control-plane-production` concurrency group with web and other
control-plane mutations. Pull-request validation remains scoped to its PR. When
the protected control-plane wrapper calls the reusable provider workflow, it
passes `parent_holds_control_plane_lock=true`; the child then uses a run-unique
group so it cannot deadlock against the lock already held by its parent.

The conformance gate verifies the RPC value returned by each service:

```ts
capabilities(): {
  protocolVersion: 1;
  providerKind: "hetzner_cloud" | "gcp_compute";
  operations: string[];
}
```

Any mismatch blocks the web deployment. Provider KEKs are available only to
the corresponding protected deployment job and are not passed to Astro build
or web deployment jobs.

Both Workshop feature flags remain default-off globally. After the pilot
organization exists, target `workshops_enabled` only to that organization.
Target `workshop_multicloud_runtime_enabled` immediately before certification
and issuance. The multicloud flag does not gate BYOK connection, inspection,
credential rotation, or cost forecasting. Removing its targeting stops new
direct-cloud certification and issuance but must not stop provider
reconciliation or deletion.

Apply and remove the organization rule only through the protected
`.github/workflows/workshop-multicloud-flag.yml` plan/apply/remove workflow.
It uses the existing account token from `CLOUDFLARE_API_TOKEN`. Preserve that
token's established deployment permissions and add the account-level
`Flagship Read`, `Flagship Evaluate`, and `Flagship Write` permissions. The
workflow rejects any rule or default outside the exact pilot contract and
retains before/after and target/control evaluation evidence. Direct dashboard
or workstation flag changes are outside the production operator boundary.

### Active GCP deployment and explicit dormant fallback

Active mode is required for GCP connection, quoting, certification, and new
learner VMs. Store a Cloud Billing API key restricted to that API as the
protected `GCP_CATALOG_API_KEY` secret. Dispatch the provider workflow from the
exact reviewed `main` revision with `deploy_gcp=true`, `gcp_dormant=false`, an
empty `gcp_dormant_confirmation`, and confirmation
`DEPLOY PROVIDER WORKERS`. The workflow must pass the explicit Wrangler
override `--var GCP_PROVIDER_MODE:active`; the checked-in configuration and a
raw deploy remain dormant.

The retained production probe must call `capabilities()` and `readiness()` on
the deployed GCP service. Active readiness is successful only when it reports
`readyForNewWork=true`, `catalog.checked=true`, a positive `lineItemCount`, and
a canonical `observedAt` timestamp after a successful live `e2-standard-4`
quote for `europe-west3-a` with a 32 GiB `pd-balanced` boot disk. A capability
response alone proves only the service-binding protocol. It does not prove
active mode, catalog access, a GCP project connection, certification,
allocation, or teardown.

The checked-in GCP Wrangler configuration defaults to dormant as a fail-closed
fallback. When active setup is not ready, the protected workflow may deploy
`intar-provider-gcp` as a route-less service so the web binding and
`capabilities()` contract can still be validated. Dormant mode is never
inferred from a missing secret. Set `gcp_dormant=true` and provide the separate
exact confirmation `DEPLOY DORMANT GCP PROVIDER`; omitting either must fail
closed.

The dormant deployment sets the Worker mode explicitly, omits
`GCP_CATALOG_API_KEY` from the deployment secrets file, and removes any
previously configured catalog secret. It retains the GCP provider KEK and
Worker/DO state. `connect`, `resolve_profile`, `quote`, `preflight_capacity`,
`ensure_foundation`, and `create_instance` must reject the request before token
exchange, catalog lookup, or any GCP API mutation. Capability RPC remains
available through the service binding.

Dormant mode does not disable read-only connection inspection, credential
rotation, observation, reboot, deletion, sweeping, or reconciliation for
allocations created after a later activation. Inspection and rotation may call
GCP to recover cleanup visibility or authority, but they cannot establish a new
connection, create foundation resources, or issue an instance. This is
intentional: an incident may stop new GCP work without orphaning already billed
resources. Do not delete the Worker, its KEK, encrypted credentials, or
reconciliation state until every allocation and resource has confirmed
deletion.

The production gate uses `wrangler dev --remote` with the route-less
`tools/providers/live-capability-probe/wrangler.jsonc` entry Worker. It binds to
the two deployed services, calls both `capabilities()` methods and the GCP
`readiness()` method through Cloudflare service-binding RPC, validates the
expected deployment mode and response, then terminates.
It neither deploys a persistent probe Worker nor creates a route. The protected
`CLOUDFLARE_PROVIDER_PROBE_API_TOKEN` is scoped separately from both provider
deployment tokens, and CI retains the non-secret response as rollout evidence.

Durable Object lifecycle changes require `wrangler deploy`; version upload alone
does not apply them. New provider Workers use SQLite-backed Durable Objects.

Before provider deployment, record the active web Worker version UUID, its D1
UUID and binding, and the reviewed source SHA. Provider Workers may remain
deployed during web recovery so cleanup can continue. Recovery evidence must
identify every allocation, resource, and operation and show it deleted or
owner-visible as `cleanup_pending`; do not delete provider KEKs while any such
state remains.
