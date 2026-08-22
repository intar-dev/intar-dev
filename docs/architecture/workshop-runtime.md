# Multi-cloud Workshop runtime

The Workshop runtime is a provider-neutral control loop. It deliberately does
not reuse Course or Scenario domain records. Scenarios keep their existing
`DesiredVmV2` host path; Workshops use the common runtime ledger and select one
certified profile from their immutable revision.

```text
browser
  |
  v
Astro web Worker  ---- D1 (canonical lifecycle, progress, cost)
  |       |
  |       +---- R2 (signed bundles, recordings, learner artifacts)
  |
  +-- service binding --> intar-provider-hetzner --> Hetzner API
  |
  +-- service binding --> intar-provider-gcp -----> GCP APIs
  |
  +-- existing runner bridge --------------------> agent_kvm host
  |
  +-- Stargate --> SSH direct forwarding --> learner VM
```

Only the Astro entry Worker has an HTTP route. Provider Workers expose RPC
entrypoints through service bindings and return `404` from `fetch`. Their
Durable Objects serialize one provider connection's mutations; a D1 minute
sweep recovers missed alarms, so Durable Object storage is never the sole
source of business state.

## Ownership boundaries

The generic Workshop lifecycle owns:

- authorization, roster entitlements, and global active slots;
- workspaces, executions, generations, progress, and checkpoint choice;
- guest bootstrap/report credentials and stale-generation rejection;
- Stargate terminal and application routes;
- recording drain, artifacts, recovery policy, and session teardown;
- provider-neutral D1 state transitions and cost aggregation.

A provider adapter owns:

- connection inspection and encrypted credential rotation;
- machine/image/location catalog resolution;
- provider API calls, deterministic idempotency, and retry classification;
- resource discovery, asynchronous operation observation, and deletion proof;
- provider price observations and provider-specific billing rules.

Direct-cloud adapters never synthesize an `agent_host`. Each cloud resource is
recorded independently before its asynchronous operation is polled. Ambiguous
responses are reconciled by deterministic name, labels, and request identity
before a create or delete is retried.

## Runtime profiles

A format-v2 Workshop revision records resolved, immutable profiles. A profile
contains the provider kind, exact machine type and hardware shape, exact image
identity, architecture, disk policy, and permitted locations. Publication
fails if any declared profile cannot be certified. Session creation never
substitutes a provider, machine type, image, or location set.

The Platform Engineering production revision declares two exact profiles:
`hetzner-cpx42`, which uses Hetzner CPX42 with Debian 13, and
`gcp-e2-standard-4`, which uses GCP `e2-standard-4`, a 32 GiB `pd-balanced`
boot disk, the Debian 13 image family, and Frankfurt zones `europe-west3-a`,
`b`, then `c`. Publication requires separate successful certification for both
profiles. Declaring the GCP profile does not prove that a live GCP allocation or
teardown has passed.

Compatible profiles consume the same `direct_cloud_linux_x86_64_v1`
checkpoint bundles. Bundles contain no OCI layers; the guest pulls every
declared image by digest.

## Allocation state machine

```text
requested -> preparing -> allocating -> bootstrapping -> ready
     |           |             |              |
     +-----------+-------------+--------------+-> failed

ready -> draining -> deleting -> deleted
                      |
                      +-> cleanup_pending -> deleting
```

An active slot is acquired before allocation and released only after all
provider resources and Stargate routes are confirmed absent. Guest reports are
generation-bound and monotonically sequenced. A workspace is degraded after 45
seconds without a report and recovery-eligible after 90 seconds. The provider
gets one reboot attempt; after three minutes the generic lifecycle reconstructs
the latest applicable checkpoint in a new generation.

Normal module progression never replaces the VM. Restore and recovery revoke
routes, drain recordings, delete the old generation, and then allocate the new
one, preserving Workshop progress and append-only audit history.

## Cost model

Quotes are immutable line items with integer currency nanos. Each line records
provider, SKU, resource kind, location, unit, quantity, billing granularity,
minimum duration, optional cap, tax treatment, and source timestamps.

Forecasts store expected, lease-ceiling, and one-restore scenarios. Live and
final estimates use actual resource lifetimes and each provider's independent
rounding rules. Budget ceilings block new allocations and restores, but they
never terminate an already running learner.
