# Intar GCP provider Worker

`intar-provider-gcp` is a route-less auxiliary Worker. The web Worker reaches
`GcpProviderService` only through `GCP_PROVIDER_SERVICE`; it has neither a
workers.dev URL nor a preview URL.

One `GcpConnectionDO` serializes mutations for each organization connection.
D1 remains canonical: the Durable Object stores no credential, allocation,
operation, cost, or resource identity. Every create/delete response carries
canonical writes that the web Worker must persist before its next provider
call.

The Worker holds two independent secrets:

- `GCP_PROVIDER_CREDENTIAL_KEK_V1` wraps random per-version credential DEKs.
- `GCP_CATALOG_API_KEY` reads the public Cloud Billing catalog for USD list
  prices; it is never sent to Compute or returned by RPC.

Connection validates a dedicated project, required APIs, the absence of the
default VPC and foreign Compute resources, resolves `e2-standard-4` and the
Debian 13 image family, creates the deterministic custom VPC/subnet/SSH-only
firewall sentinel, and only then returns the encrypted service-account key.

Learner inserts use deterministic RFC 9562 UUIDv8 `requestId` values. Instances
set an empty service-account list, block project-wide SSH keys, install only an
instance-scoped key, request one ephemeral IPv4 without `natIP`, and attach an
auto-delete 32 GiB `pd-balanced` boot disk. Guest services remain private; only
Stargate can reach SSH through the sentinel firewall.
