---
title: Image Registry Cleanup
---

The image registry cleanup collector deletes image artifacts in the registry
bucket that no live record references. It is an auxiliary worker of the
website. It has no public route and no workers.dev address, and only the parent
worker reaches it, through a service binding.

A Cron Trigger starts the collector on this schedule, in UTC:

```
17 */6 * * *
```

The runs are at 00:17, 06:17, 12:17, and 18:17.

## What the collector keeps

The collector deletes only inside four prefixes of the registry bucket:

* `image-manifests/v1/`
* `image-chunks/v1/zstd6/`
* `images/`
* `artifacts/`

It keeps every object that a live record still needs:

* the live image of each scenario, VM, and architecture;
* one rollback per scenario, VM, and architecture. A rollback record can cover
  part of the fleet, so it retains only the VMs it names;
* the current candidate of each scenario, until the live catalog carries that
  revision, and the candidate row that a run in flight was admitted from;
* the image of each run in flight, and the images that an enabled host runs or
  fetches now;
* the artifacts of each build that a kept image still needs.

A chunk object is shared. The collector deletes a chunk only when no kept
manifest names it. A boot artifact stays when any kept image names it.

A build whose artifacts no reference needs becomes **retired**. A retired build
is an audit row, and it pins nothing. Its source bundle stays in the bucket, so
the build is reproducible. A later request for that image triggers a rebuild:
the scheduler reads the retirement marker, so a retired build is never reported
as complete.

The collector never touches these objects:

* the build logs and the source bundles under `builds/`;
* the guest tools under `guest-tools/`;
* the run-artifacts bucket.

The rule is a reference rule, not an age rule. A candidate has no expiry: it
stays until the live catalog carries its revision.

The collector fails closed. It deletes nothing in a run when a required
manifest is missing or invalid, when a chunk or a boot artifact of a kept image
is absent, or when the bucket listing is incomplete. A legacy single-object
image carries no manifest, and it stays supported.

## Modes

The `REGISTRY_CLEANUP_MODE` variable selects the mode.

| Mode | Effect |
| --- | --- |
| `report-only` | Lists the candidate objects. Deletes nothing. |
| `delete` | Deletes the candidate objects. |

An unreadable or unknown value becomes `report-only`. An unknown value never
widens the authority of the collector.

## The safety rules

1. The collector reads the maintenance flag from the version that serves
   traffic. When maintenance is on, it stops before the database or the bucket.
2. A deployment holds the collector before a migration and releases it after
   the deployment. The hold has no expiry: it stays until an operator or a lane
   sends `resume`. Only the wait for an idle collector is bounded.
3. It plans before it deletes. One run produces one plan, and the plan names
   every candidate object.
4. A delete run takes an exclusive sweep. The sweep starts only when no upload
   session is open, no write is unresolved, and no earlier run is still
   running. The collector reads the state again for each delete batch, and it
   stops when a writer appears.
5. A report run takes no sweep and writes nothing. It can run while an upload
   session is open, so its candidate list is a preview. A delete run builds and
   verifies its own plan inside the sweep.

## Admission records

Every registry write registers a marker row in the admission tables, and it
releases the row when the write settles. Three conditions block a sweep:

* an open upload session;
* a write that did not settle;
* a write that ended without a definite result.

No timer clears the last two. The operator resolves them. Read
`GET /registry/v1/admission`: when `idle` is false, `idle_blocked_reason`
names the cause. Send `POST /registry/v1/admission/reap` to resolve a write
that stopped, and add `{"resolve_stalled_sweeps": true}` to resolve a sweep
that stopped in the middle. The reap clears a write with no definite result at
once. For a write that never reported, it waits one hour by default; send
`grace_ms` to choose another delay.

A closed session answers a repeated close for six hours. Compaction then
removes the session and its released rows.

## Deploy the collector

The website deployment lane deploys the collector. You do not deploy it on its
own.

A Worker deploy fails when a service binding points at a service that does not
exist. The lane therefore splits the parent deploy in two phases: the
**bootstrap parent** carries the tested configuration without the binding to the
collector, and the **full parent** carries the binding.

The lane works in this order:

1. It reads the live collector state from the Cloudflare API, and it resolves
   the mode for this release.
2. It holds the collector and waits for an idle state. The control plane still
   serves here, so the hold travels through it.
3. It closes the control plane, deploys the parent of this revision (the
   bootstrap parent on a first rollout), and applies the pending migrations.
4. It deploys the collector from the auxiliary configuration in the tested
   website artifact, and then the full parent at 100 percent.
5. It releases the collector after the control plane serves again, and it runs
   the bounded delete campaign when delete mode is live.
6. When the resolved mode is `report-only`, it verifies the collector through
   the parent binding: one `plan` call, and the collector must read the
   maintenance flag as `off` from the control plane that serves traffic, and
   the plan must be complete and fault free. A plan is a read, so this step
   deletes nothing.

An **absent** collector is a confirmed HTTP 404 from the Cloudflare API. An
answer the lane cannot read (an expired token, a forbidden account, a network
failure) stops the lane. It is never a first rollout.

## The mode of a release

The `registry_cleanup_mode` input of the **Website cutover** workflow has
three values:

| Value | Effect |
| --- | --- |
| `preserve` | Keeps the mode that the deployed collector proves. A first rollout becomes `report-only`. |
| `report-only` | Deploys the collector in report-only mode. |
| `delete` | Deploys the collector in delete mode. |

`preserve` is the default. A routine release never downgrades a collector that
already deletes, and it never guesses when the live mode is unreadable.

An explicit `delete` request turns on the shared upload admission switch
before the maintenance window closes. The step calls the published API:

```
POST /registry/v1/admission/enforcement   {"mode":"enforce"}
```

The call uses the registry publish token, and the step verifies the answer
against the shared database: `enforcement` `enforce` with `session_required`
true, or the release stops before it closes the control plane. Every other mode
leaves the switch as it was found, so an emergency switch-off stays in force.
Evidence: `registry-cleanup-activation.json` (no credential).

Run the **Website cutover** workflow, set `registry_cleanup_mode` to
`preserve`, `report-only`, or `delete`, and start it.

Three live conditions gate delete mode. A first rollout cannot delete at all. A
later rollout deletes only when all three hold:

1. The deployed collector proves the mode `report-only` or `delete`. An
   unreadable mode is delete-capable for the hold, but it cannot stand in for a
   proven preview.
2. The lane took a complete, fault-free report inventory from that collector.
   The mode alone is not that proof.
3. The collector reports `enforcement` `enforce` and `sessionRequired` true
   for the shared D1 upload admission row. The hold evidence records both
   values.

The builder host must run the verified session-aware uploader before you choose
delete mode. That condition is an operator attestation, because the lane cannot
read it. See the release order below.

## Clear the backlog in the rollout

A release that turns deletes on does not wait for the six-hourly tick. After
the collector is released, the lane runs one delete campaign.

The campaign runs inside `tools/deploy/registry-cleanup-gate.sh`, and it is
bounded twice: by 64 passes and by wall clock. The wall-clock deadline is 60
minutes when the deployment lane runs the campaign, because a full plan is
measured at roughly 90 seconds and a large backlog needs more than one pass.
The script's own default is 15 minutes, which is what a manual call gets, and
the deployment job allows 75 minutes so the campaign deadline fits inside it.
One campaign pass has its own request ceiling of 10 minutes, because a pass
scans the bucket and then deletes what the scan listed, while the other actions
keep the 2-minute ceiling that one read needs. The two ceilings keep the worst
case inside the job: 60 minutes of campaign plus one pass of at most 10 minutes
is 70 minutes.
It calls the collector with the `run` action and repeats only while a pass answers
`pending` or `busy`. A pass that answers `core-failed`, `paused`,
`fenced`, or anything unexpected stops the campaign as a failure. A
`report-only` collector is refused before the first pass, because a run
against it would delete nothing.

The campaign finishes with a fresh report, and that report is the proof: the
candidate total must be zero, the plan must be complete and fault free, and its
scanned keyset digest must equal the digest the finished campaign recorded. A
count alone never proves it, because two key sets can share a count.

The script writes every pass, the totals, the final report, and the delete set
to `registry-cleanup-run.json`. Key lists in that file are capped at 5000
entries, and the script refuses to publish evidence that carries the bypass
secret.

## Promote an image catalog

The **Image catalog promotion** workflow drains the fleet, promotes the catalog,
and then waits for the collector. The promotion endpoint deletes the retired
artifacts before it reports success: while that cleanup runs, the endpoint
answers HTTP 503 with `catalog_promoted` true and `retry` true, and the
workflow repeats the call until the endpoint reports completion. The workflow
never opens the fleet gate, so the gate opens only after the cleanup is
complete.

The promotion refuses when another reference still needs an outgoing image. It
answers HTTP 409 "catalog promotion is blocked by active image use" and names
the blocking executions and hosts, and it answers HTTP 409 while a desired VM
is running, so the fleet drains first. The live image, the rollback, and the
running VM are never removed to meet that limit: the lane stops and reports the
conflict instead.

## Reopen the control plane

The **Website cutover** workflow has two operations. The `cutover` operation
closes the control plane. The `reopen` operation returns the release to
service.

A cutover keeps the collector held for the whole window. The reopen returns the
release to service, and the lane then releases the collector and proves that no
hold survives. A paused collector deletes nothing and refuses no learner, so a
held collector is safe in both directions.

## Read the collector state

The collector has no route of its own. You reach it through the maintenance
surface of the control plane, and that surface stays available while
maintenance is on.

Send a hold request with the maintenance bypass secret:

```bash
curl --request POST \
  --header 'Content-Type: application/json' \
  --header 'Origin: https://intar.dev' \
  --data "$(jq -cn --arg secret "${CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET}" \
    '{secret: $secret, action: "pause", wait_ms: 30000}')" \
  https://intar.dev/api/maintenance/registry-cleanup
```

The `Origin` header is optional. A supplied `Origin` must be the canonical
origin, and the content type must be `application/json`. The secret authorizes
the call; a wrong secret or a wrong origin is HTTP 403 with no code.

Change `action` to `resume` to release the collector, to `plan` to read a
report inventory without a hold, to `status` to read the collector report, or
to `run` to make one delete pass. A single pass is rarely enough: the
deployment lane repeats it inside the bounded campaign.

A refusal carries a code: `maintenance` is the fence,
`registry_cleanup_unavailable` is a parent without a binding to the collector,
and `registry_cleanup_gate_unconfigured` is a parent without a usable secret.

The status report carries `enforcement` and `sessionRequired` for the shared
upload admission row, and it reports `paused` and `idle` under `result`. An
unreadable field stays `null`. A hold does not time out: a collector that stops
between the hold and the release stays held until `resume` clears the row.

Use `tools/deploy/registry-cleanup-gate.sh` for the same operation; the deploy
lane uses that script. The script reads the collector state itself, and an
unreadable state stops it.

## Order the release

The collector reads live references, so it cannot delete an artifact that a live
record still names. This order keeps the reference state correct at every step.

1. Merge the code: the upload session on the server, the collector, and the
   deployment lane.
2. Publish the `intar-builder` and `intar-image-cli` releases. They carry the
   admission session, but the server does not publish the session endpoint yet,
   so the host install comes later.
3. Release the website with `registry_cleanup_mode: preserve`. On a first
   rollout the collector serves in `report-only`, and the lane applies the
   pending migrations. The upload-session endpoint is live after this step.
4. Install `intar-builder` and `intar-image-cli` on the builder host
   (`docs/src/content/docs/operations/builder-host.md`). The uploader now holds
   one session from the first chunk probe to the publish.
5. Run the **Website cutover** with `registry_cleanup_mode: delete`, then run
   the `reopen` operation for the same revision. The cutover turns on D1
   admission enforcement, holds the collector, migrates, deploys and releases;
   the reopen runs the bounded delete campaign.
6. Read `registry-cleanup-run.json`, and confirm the exact reclaim: the final
   report must show zero candidates and the digest match. Open the runtime
   cutover gate when the fleet is ready.

The guest-tools operator endpoints do not need an upload session. They keep
their own admission guard for the short write path.

## Find the evidence

Every deployment writes evidence to the workflow run. Look for these files:

| File | Content |
| --- | --- |
| `registry-cleanup-state.json` | Whether a collector version already answers |
| `registry-cleanup-mode.json` | The requested mode, the live mode, and the mode this release resolves to |
| `registry-cleanup-hold.json` | The hold, the idle proof, the collector status (`enforcement`, `sessionRequired`, the sweep state), and the delete-mode inventory |
| `registry-cleanup-activation.json` | The admission activation: the requested mode, the D1 answer, and the switch proof |
| `registry-cleanup-deploy.json` | The deployed version, the schedule, the bindings, and the parent phase this deploy proves |
| `web-bootstrap.json` | The bootstrap parent deploy on a first rollout |
| `registry-cleanup-release.json` | The release request and the resulting state |
| `registry-cleanup-preview.json` | The report-only preview through the parent binding: the maintenance flag, its source, and the plan |
| `registry-cleanup-child.json` | Whether the reopen kept the deployed collector or refuses to replace it, and the revision and mode it read |
| `registry-cleanup-run.json` | The delete campaign: every pass, the totals, the final report, and the delete set |
| `intar-registry-cleanup-deploy-<run id>/` | The raw Wrangler output of the collector deploy |

The website validation lane also checks the auxiliary worker configuration in
the tested artifact. A build that loses the collector fails before the
deployment lane starts.

## Repair a failure

| Symptom | Action |
| --- | --- |
| "the live control plane can not serve the image registry cleanup fence" | Deploy the parent revision, then run the lane again. |
| "the registry cleanup state probe failed" | Repair the Cloudflare API access, then run the lane again. This is not a first rollout. |
| "the first deployment of the collector cannot delete" | Deploy the report-only preview, read its candidate list, then deploy delete. |
| "the live collector mode is unreadable, so no preview can be proven" | Deploy a report-only preview, then run the delete release again. |
| "delete mode needs the hold evidence from the deployment gate" | Run the lane again from the start; the hold step writes the plan and the status. |
| "The deployment gate refused the request" | Check `CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET` and the origin of `REGISTRY_CLEANUP_GATE_URL`. |
| "the collector status is unreadable" | Check the parent worker and the gate route, then run the lane again. |
| "admission enforcement must be on", or "the activation step failed" | Read `registry-cleanup-activation.json`. Run the Website cutover with `registry_cleanup_mode: delete` again: the activation step turns the switch on through the registry API and verifies the D1 answer, and the release stops before the control plane closes when the switch does not prove. |
| "a reopen can not replace the delete-capable registry cleanup worker" | Run the Website cutover for this revision with `registry_cleanup_mode: delete`. A reopen that only returns an unchanged release to service keeps the collector. |
| A fence message, or a run that reports `fenced` | The hold ran while the control plane was closed, or maintenance is still on. Run the lane again from the start; it holds the collector before maintenance closes. |
| "this rollout holds the registry cleanup worker, but the deployment gate is unreachable" | Send `resume` through the maintenance surface, then run the lane again. |
| A run reports `paused` | A deployment holds the collector. Send `resume`, or run the deployment lane again. |
| "the cleanup campaign did not finish" | Read `registry-cleanup-run.json`: `run.reason` names the cause, and `run.final_report` carries the proof. Run the lane again; the campaign resumes from the current state. |
| "the serving collector mode is report-only, and a run would not delete" | Release with `registry_cleanup_mode: delete`, or with `preserve` when delete mode already serves. |
| "the report preview did not prove a healthy report-only collector" | Read `registry-cleanup-preview.json`: maintenance was on, the flag did not come from the serving control plane, or the plan was incomplete. Repair the cause, then run the lane again. |
| A schedule check fails | Deploy the collector again from the tested artifact. |
