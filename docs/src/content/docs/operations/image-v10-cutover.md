---
title: Image v10 Cutover
---

Image v10 uses 4 MiB content-addressed chunks and a separate read-only guest
tools disk. Normal image CI publishes only a candidate catalog. HTTP 202 means
the bundle entered the queue; CI then waits for completed builds and exact host
cache reports.

## Cut over

1. Deploy the Worker migrations and Bridge v7 control plane.
2. Install the matching `intar-builder`, `intar-agent`, and jailer package on
   the current hosts.
3. Confirm the candidate revision reports `ready` at
   `/registry/v1/builds/revisions/<revision>?tools=candidate`.
4. Run the **Image v10 flag-day cutover** workflow from `main`. Enter the exact
   candidate revision and `DRAIN AND CUT OVER IMAGE V10`.

The workflow blocks new agent-KVM starts, waits for active VMs to finish,
promotes the catalog, promotes guest tools, and requires the stable cache to
converge in less than 60 seconds. It always reopens the start gate when it ends.

## Roll back

Drain the fleet again. While the new control plane is still running, call:

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $INTAR_IMAGE_PUBLISH_TOKEN" \
  --header "x-intar-drained: true" \
  "https://intar.dev/registry/v1/catalog/rollback/<revision>"
```

Then restore the retained old host packages and warm the retained raw images
before starts reopen. The pre-cutover catalog snapshot and old R2 objects remain
available for at least seven days. Jailerd starts the seven-day legacy-template
retention clock when v10 first runs; it does not delete a live legacy template.
