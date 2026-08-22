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
`readiness()`. Dormant readiness returns without a network call. Active
readiness performs a live Frankfurt catalog quote, so it proves that the
catalog key works without returning that key or another secret. Dormant mode
permits reconciliation, reboot, deletion, and sweeping of allocations that
already exist. Credential rotation and read-only connection inspection also
remain available so cleanup authority and visibility can be recovered without
enabling issuance. The narrow `validate_foundation` operation remains available
too; it exact-GETs the VPC, subnet, firewall, and routes, rejects missing or
drifted state, and never creates or changes a resource. New connection, profile
resolution, quoting, preflight, foundation creation, and instance creation fail
before a GCP or catalog request.
Active mode also fails closed when the catalog key is absent; a missing secret
never changes the explicitly configured mode.

Connection validates a dedicated project, required APIs, Cloud Billing account
association, `billingEnabled=true`, and every IAM permission used by the exact
Compute insert and foundation requests. It also rejects the default VPC and
foreign Compute resources, resolves `e2-standard-4` and the Debian 13 image
family, creates the deterministic custom VPC/subnet/SSH-only firewall sentinel,
and only then returns the encrypted service-account key. A retry accepts an
existing sentinel only when its network, subnet, firewall, subnet route, and
untagged default Internet route still match the locked Workshop foundation.
Any missing or competing custom route fails closed. Foundation checks call both the
global and Frankfurt regional effective-firewall APIs. They reject inherited,
global, regional, or classic ingress allows that could reach `intar-learner`
outside the exact Stargate `/32` source set on TCP port 22. They also reject an
ingress deny, egress deny, or security-profile action that can isolate the guest
or stop bootstrap and runtime traffic. The service account
therefore also needs `compute.networks.getEffectiveFirewalls` and
`compute.networks.getRegionEffectiveFirewalls` for setup and cleanup visibility.

Learner inserts use deterministic RFC 9562 UUIDv8 `requestId` values that include
the target zone. Instances set an empty service-account list, block project-wide
SSH keys, request one ephemeral IPv4 without `natIP`, and attach an auto-delete
32 GiB `pd-balanced` boot disk. The cloud-config is stored as `user-data`. A
separate GCE bash startup script installs and enables cloud-init, writes a
NoCloud seed, and reboots once. Cloud-init owns the `intar` user and its
instance-scoped SSH key. Guest services remain private; only Stargate can reach
SSH through the sentinel firewall.
