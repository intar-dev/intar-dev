# Intar GCP provider Worker

`intar-provider-gcp` is a route-less auxiliary Worker. The web Worker reaches
`GcpProviderService` only through `GCP_PROVIDER_SERVICE`; it has neither a
workers.dev URL nor a preview URL.

One `GcpConnectionDO` serializes mutations for each organization connection.
D1 remains canonical: the Durable Object stores no credential, allocation,
operation, cost, or resource identity. Every create/delete response carries
canonical writes that the web Worker must persist before its next provider
call.

The Worker uses two independent secrets:

- `GCP_PROVIDER_CREDENTIAL_KEK_V1` wraps random per-version credential DEKs.
- `GCP_CATALOG_API_KEY` reads the public Cloud Billing catalog for USD list
  prices; it is never sent to Compute or returned by RPC.

The KEK is always required. The checked-in Wrangler configuration defaults to
`GCP_PROVIDER_MODE=dormant`, so an ad-hoc or local deployment cannot enable new
GCP work. The protected CI workflow must pass
`--var GCP_PROVIDER_MODE:active` explicitly when activation is intended and a
catalog key is available. Dormant mode still exposes `capabilities()` and
permits reconciliation, reboot, deletion, and sweeping of allocations that
already exist. Credential rotation and read-only connection inspection also
remain available so cleanup authority and visibility can be recovered without
enabling issuance. New connection, profile resolution, quoting, preflight,
foundation creation, and instance creation fail before a GCP or catalog request.
Active mode also fails closed when the catalog key is absent; a missing secret
never changes the explicitly configured mode.

Connection validates a dedicated project, required APIs, the absence of the
default VPC and foreign Compute resources, resolves `e2-standard-4` and the
Debian 13 image family, creates the deterministic custom VPC/subnet/SSH-only
firewall sentinel, and only then returns the encrypted service-account key.

Learner inserts use deterministic RFC 9562 UUIDv8 `requestId` values. Instances
set an empty service-account list, block project-wide SSH keys, install only an
instance-scoped key, request one ephemeral IPv4 without `natIP`, and attach an
auto-delete 32 GiB `pd-balanced` boot disk. Guest services remain private; only
Stargate can reach SSH through the sentinel firewall.
