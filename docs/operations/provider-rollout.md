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

For a provider-affecting change, `.github/workflows/provider-workers.yml`
installs the single root Bun workspace, runs package and provider conformance
tests, builds both route-less Workers, and can deploy either Worker independently.
The protected `.github/workflows/control-plane-rollout.yml` deploys both provider
Workers before invoking the web deployment. A regular web deployment performs
the same capability-contract gate but never redeploys a provider.

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

The production gate uses `wrangler dev --remote` with the route-less
`tools/providers/live-capability-probe/wrangler.jsonc` entry Worker. It binds to
the two deployed services, calls both `capabilities()` methods through
Cloudflare service-binding RPC, validates the exact response, then terminates.
It neither deploys a persistent probe Worker nor creates a route. The protected
`CLOUDFLARE_PROVIDER_PROBE_API_TOKEN` is scoped separately from both provider
deployment tokens, and CI retains the non-secret response as rollout evidence.

Durable Object lifecycle changes require `wrangler deploy`; version upload alone
does not apply them. New provider Workers use SQLite-backed Durable Objects.
