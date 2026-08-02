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

> **Provider-mutation approval blocker:** the current provider workflow has not
> yet implemented the same actor identity, expiry, recent-admin-attestation, and
> main-only environment-policy checks used by the web deployment's
> single-operator mode. Do not mutate either provider while production is in
> single-operator mode. Proceed only after either (a) production is placed in
> reviewed mode with administrator bypass disabled, a required reviewer, and
> self-review prevention, or (b) the risk of the same explicitly accepted,
> time-bounded single-operator model is approved and that guard is implemented
> and validated in the provider workflow.

The canonical clean-slate production order is:

1. run clean-D1 `plan` and retain its inventory and baseline digest;
2. run clean-D1 `apply` and retain the new database UUID;
3. set and verify `CLEAN_D1_DATABASE_ID` and
   `CLEAN_D1_DATABASE_NAME` in the protected production environment;
4. dispatch `.github/workflows/control-plane-rollout.yml`, which deploys and
   probes both provider Workers before invoking web deployment.

Do not deploy a provider as a workaround for an incomplete D1 cutover, and do
not deploy web against the checked-in all-zero database placeholder. Before
step 1, disable old issuance and retain proof of zero old provider allocations,
VMs, disks, IPs, keys, operations, Stargate routes, and global active slots.
The new application cannot reconcile rows left only in the old database.

For a provider-affecting change, `.github/workflows/provider-workers.yml`
installs the single root Bun workspace, runs package and provider conformance
tests, builds both route-less Workers, and can deploy either Worker independently.
The protected `.github/workflows/control-plane-rollout.yml` deploys both provider
Workers before invoking the web deployment. A regular web deployment performs
the same capability-contract gate but never redeploys a provider.

Direct production dispatches of `provider-workers.yml` share the
`intar-control-plane-production` concurrency group with clean-D1 and web
mutations. Pull-request validation remains scoped to its PR. When the protected
control-plane wrapper calls the reusable provider workflow, it passes
`parent_holds_control_plane_lock=true`; the child then uses a run-unique group so
it cannot deadlock against the lock already held by its parent.

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

Both Workshop feature flags remain default-off globally. After the separately
recorded first-owner bootstrap handoff creates the pilot organization, target
`workshops_enabled` only to that organization. Target
`workshop_multicloud_runtime_enabled` immediately before certification and
issuance. The multicloud flag does not gate BYOK connection, inspection,
credential rotation, or cost forecasting. Removing its targeting stops new
direct-cloud certification and issuance but must not stop provider
reconciliation or deletion.

### Explicit dormant GCP deployment

The checked-in GCP Wrangler configuration defaults to dormant. When no GCP
project or catalog credential is available, the protected workflow may deploy
`intar-provider-gcp` as a route-less service so the web binding and
`capabilities()` contract can be validated. This mode is never inferred from a
missing secret. Set `gcp_dormant=true` and provide the separate exact
confirmation `DEPLOY DORMANT GCP PROVIDER`; omitting either must fail closed.

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

To activate GCP later, configure the protected `GCP_CATALOG_API_KEY`, dispatch
the workflow with `gcp_dormant=false`, and do not supply the dormant confirmation.
The CI deployment must override the dormant config with the explicit Wrangler
argument `--var GCP_PROVIDER_MODE:active`; a raw deploy without that override
remains dormant.
Only after the non-dormant deployment and capability probe succeed may an owner
connect a GCP project or an administrator certify or issue a GCP runtime.

The production gate uses `wrangler dev --remote` with the route-less
`tools/providers/live-capability-probe/wrangler.jsonc` entry Worker. It binds to
the two deployed services, calls both `capabilities()` methods through
Cloudflare service-binding RPC, validates the exact response, then terminates.
It neither deploys a persistent probe Worker nor creates a route. The protected
`CLOUDFLARE_PROVIDER_PROBE_API_TOKEN` is scoped separately from both provider
deployment tokens, and CI retains the non-secret response as rollout evidence.

Durable Object lifecycle changes require `wrangler deploy`; version upload alone
does not apply them. New provider Workers use SQLite-backed Durable Objects.

Before provider deployment, record the previous web Worker version UUID, its
previous D1 UUID and binding, the reviewed source SHA, and the zero-resource
inventory. Provider Workers use new route-less identities and may remain
deployed during a web/D1 rollback so cleanup can continue. Rollback evidence
must identify every allocation/resource/operation and show it deleted or
owner-visible as `cleanup_pending`; do not delete provider KEKs while any such
state remains.
