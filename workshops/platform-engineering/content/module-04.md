# Module 04 — Self-service: your platform gets an API

## The goal

At the end of this module your platform exposes its own API: developers write a 10-line
`WorkshopDatabase` resource and get a whole stack — a Postgres cluster *and* an S3 bucket
— provisioned, wired, and lifecycle-managed. You prove it by pushing exactly such a
10-liner and running `./verify.sh`.

## Why this matters

Module 03 made *you* capable of provisioning databases — but your developers shouldn't
need to know CNPG, storage classes, or RustFS endpoints. Platform engineering is building
the **abstraction**: you define an API (`WorkshopDatabase`) and an implementation
(Crossplane Composition), developers consume the API. This is precisely what `aws rds
create-db-instance` is — except you own both sides of it now.

⚠️ **A word about training data (yours and your AI's):** this is Crossplane **v2**.
Claims are gone — you create namespaced XRs directly. Compositions are pipeline-mode only
and emit *plain Kubernetes resources* (a CNPG `Cluster`, a `Job`) directly, no
provider-kubernetes wrapping. Most tutorials online — and most LLM answers — still
describe v1. If you see `kind: Claim`, `claimNames`, or `resources:` at the top level of
a Composition, you're reading the past.

## The task

1. Enable `crossplane.yaml` from the catalog (this installs Crossplane v2, the
   patch-and-transform function, and RBAC allowing it to manage CNPG clusters and Jobs).

2. **Ship your platform API.** This lab dir contains the two halves under
   [`platform/`](platform/):
   - [`xrd.yaml`](platform/xrd.yaml) — *what* developers may ask for (read the schema!)
   - [`composition.yaml`](platform/composition.yaml) — *how* it's implemented

   Deliver them via your repo as a new component + Application (template:
   [`platform-api-app.yaml`](platform-api-app.yaml)). Confirm the XRD becomes
   `ESTABLISHED`.

3. **Be the developer.** Push [`examples/my-database.yaml`](examples/my-database.yaml)
   into your demo component. Then watch the stack unfold: the XR, the composed CNPG
   cluster (`my-db-pg`), its pods, and the bucket Job. How does Crossplane report the
   whole tree?

4. Run `./verify.sh`.

## Hints

## Check your work

```bash
./verify.sh
```

It checks: the crossplane and platform-api apps are Healthy (Synced is the happy path; sync is advisory); the
`function-patch-and-transform` Function is installed and healthy; the XRD is Established;
the Composition exists; `my-db` is Synced *and* Ready; the composed CNPG cluster
`my-db-pg` is healthy; and the `my-db-assets` bucket really exists in RustFS.

## Explain-back

Tell your neighbor: your teammate asks "why not just give developers the CNPG YAML from
module 03 — it was only 30 lines?" Give the two strongest answers you have. (Think:
what can you change later without touching developers? what can developers *not* do
through this API?)

## Going deeper

- Edit `my-database.yaml` to `size: medium` (or `large`) via git. Watch the **one knob**
  ripple: the CNPG cluster gains replicas (2, then 3 — HA) and storage, all from one word.
  Then try `size: xlarge` — where does the rejection come from? That's your API's T-shirt
  enum doing policy. The developer never sees a CNPG field; the platform team owns what a
  size *means* in the Composition. That's the facade (PRD-0006).
- Delete `my-database.yaml` from the repo and push. Watch Crossplane tear down the whole
  composed stack (prune → XR deleted → composed resources garbage-collected). Re-add it.
- Add a `status` field: patch the composed cluster's readiness or connection Service name
  back onto the XR (`ToCompositeFieldPath` patches) so developers can `kubectl get wdb`
  and see where to connect.

## Optional AI assistance — with the v2 warning

Assistants are genuinely useful for reading Compositions. But this is where training-data
skew bites hardest: if your assistant proposes Claims or provider-kubernetes `Object`
wrappers, it's writing Crossplane v1. Paste it the XRD + composition from this repo as
context and ask it to stay within v2 semantics. This is optional; the bundled content,
hints, solution, and verifier are the complete offline path.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/04-self-service/verify.sh`. Layered hints and the solution are released separately by Intar.
