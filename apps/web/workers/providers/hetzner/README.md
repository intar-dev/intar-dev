# Intar Hetzner provider Worker

This package is the route-less, service-bound credential and mutation boundary for
the Workshops-only `hetzner_cloud` runtime. It has no custom domain and
both `workers_dev` and version preview URLs are disabled. The website is the
only intended caller.

The Worker owns one `HetznerConnectionDO` per organization provider connection.
The object serializes project mutations, but deliberately stores no token,
provider resource ID, allocation state, or cost state. D1 in the website Worker
remains canonical. The Durable Object converts provider failures to plain
`ProviderRpcResult` values before they cross RPC, because custom `Error`
properties are not preserved by Workers RPC.

## Binding contract

Deploy this Worker as `intar-provider-hetzner`, then add this non-inheritable
binding to the website's Wrangler configuration:

```jsonc
{
  "services": [
    {
      "binding": "HETZNER_PROVIDER_SERVICE",
      "service": "intar-provider-hetzner",
    },
  ],
}
```

The caller can type the binding as:

```ts
import type { HetznerProviderService } from "@intar/provider-hetzner-worker";
import type {
  ConnectProjectRequest,
  ProviderRpcResult,
} from "@intar/provider-contracts/hetzner";

interface WorkerEnv {
  HETZNER_PROVIDER_SERVICE: Service<HetznerProviderService>;
}
```

The default `WorkerEntrypoint` exposes four RPC methods:

- `connectProject(request)` inventories the project, validates the permitted
  locations, Debian system image, per-location IPv4 prices, and the presence of
  at least one supported x86 type, proves write access by creating/reconciling
  the firewall sentinel, and only then returns an encrypted credential
  envelope. A trusted caller may also request exact server-type validation;
  ordinary organization connection does not pin a workshop type.
- `rotateCredential(request)` requires the new token to see the existing owned
  sentinel and successfully write its rules before returning a new credential
  version.
- `runOperation(request)` executes one provider step.
- `reconcile(request)` is the minute-sweep entry point. Its resource IDs and
  deterministic names must come from D1.

Exact serializable request and response types live in
[`src/contracts.ts`](src/contracts.ts). RPC results use
`ProviderRpcResult<T>` and never return raw exceptions.

Every mutation returns `canonicalWrites`. The website must commit those writes
to D1 before it polls an action or starts the next resource mutation. This is
especially important after create calls: Hetzner has no create idempotency key,
so the returned external resource and action IDs are the recovery boundary.
When a create response is ambiguous, call `reconcile` with the deterministic
name and ownership labels before retrying.

## Credential handling

`HETZNER_PROVIDER_CREDENTIAL_KEK_V1` is a base64-encoded random 32-byte key. It is a
Worker secret and must never be written to Wrangler configuration, GitHub logs,
or repository files. Production CI sets it with the protected environment's
secret mechanism before deploying the Worker.

The production GitHub environment must provide
`CLOUDFLARE_HETZNER_PROVIDER_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`HETZNER_PROVIDER_CREDENTIAL_KEK_V1`. The Cloudflare token is dedicated to deploying
this Worker; it is not the Hetzner project token. The protected workflow passes
the KEK to Wrangler through a mode-0600 temporary secrets file, registers an
exit trap that removes the file on success or failure, deploys this route-less
Worker atomically with the secret, and finishes before the website deployment
that references its service binding.

Each credential version gets a random 256-bit DEK. The token and DEK are
independently protected with AES-256-GCM. Authenticated data binds the
organization, connection, credential ID, provider, version, and encryption
purpose. Only the encrypted envelope is persisted in D1.

## Provider lifecycle

Allocation is intentionally stepwise:

1. Create Primary IPv4 (`auto_delete=true`) and persist its ID/action.
2. Create the ephemeral SSH key and persist its ID.
3. Create the server with the pinned type, system image, existing IPv4,
   firewall and key; persist server/action IDs before polling.
4. Poll actions for at most 15 seconds per RPC. The website minute sweep resumes
   longer operations and invokes `reconcile` after ambiguous timeouts.
5. On teardown, request server deletion, confirm it is absent, then remove any
   surviving IP and SSH key. Keep the active runtime slot until D1 records
   confirmed absence for all three resources. Owner disconnect may delete the
   persistent firewall sentinel only after D1 confirms the connection has no
   allocations or cleanup-pending resources.

The server create body is IPv4-only, has no networks, volumes, backups,
snapshots, load balancers, or placement groups, and never returns Hetzner's
`root_password` field. The persistent firewall has one inbound TCP/22 rule for
the configured Stargate egress IPv4 CIDRs and no outbound rules.

## Local verification

```sh
bun install --frozen-lockfile
bun run test
bun run check
WRANGLER_LOG_PATH=.wrangler/wrangler.log bun run build
```

These commands do not require a Hetzner token and do not create cloud resources.
