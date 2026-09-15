---
title: Terminal-ready cutover
description: Move the terminal-ready runtime release as one version, with traffic closed and matching rollback state.
---

The terminal-ready release changes the gateway route contract, the web
terminal client, the agent boot path, and the runtime image pins. It has no
compatibility path. Move the complete release as one version.

This page is a sequence to follow. It is not a harness, and it does not add a
script. Use the tools and flags that already exist. Read the
[fresh VM boot benchmark](./vm-boot-benchmark/) runbook for the measurement
gate.

## Hard rules

1. Close all traffic before any version change. Draining the scenario host
   alone is not enough: gateway routes, browser sessions, admin requests, and
   reader requests must stop, so no request runs against a mixed version.
2. Take all three backups before any migration: the gateway SQLite database,
   the agent state, and the D1 bookmark.
3. A rollback restores matching state, not only a binary. Migration 0005 drops
   columns, so an old gateway binary against the new database fails. Restore
   the recorded database snapshot and the D1 bookmark with the old release.
4. Maintenance is a fence, not a lock on the release. While it is `on`, every
   `/api/*` and `/agent/*` request answers the JSON 503 and every other path,
   including `/registry/*`, answers the maintenance page, and no operator
   bypass reaches the application. The cutover operation therefore closes the
   plane and deploys the ABI 2 worker, and a separate reopen operation opens
   the plane again while the fleet gate stays drained. Registry work, which
   includes the image catalog and the tools promotion, can only run after
   that reopen. The browser proof runs with the plane open and the fleet
   still drained.

## Step 1: close the gates

Order matters, because of the maintenance fence. When maintenance is `on`,
`handleMaintenanceMode` (`apps/web/src/maintenance.ts`) answers every
`/api/*` and `/agent/*` request with the JSON 503, and every other path,
including `/registry/*`, with the HTML maintenance page. No operator bypass
reaches the application. The registry that fronts the cutover gate is
therefore inside the fence, so the fleet drain must be applied while the
control plane is still open. Close the plane first and the drain can no
longer be set from CI.

Every step here talks to `/api/*` or `/registry/*`, so every one of them must
run while the plane is still open. This step never flips maintenance: the
cutover lane closes the plane itself, as the first action of step 4.

```sh
# 1. Runtime cutover gate: block new scenario placement fleet-wide. The lane
#    sets the state and polls until the registry reports drained with
#    active_desired_vms zero.
gh workflow run image-ops.yml --ref main \
  -f operation=gate-drained -f confirmation='SET IMAGE GATE DRAINED'
curl -sS -H "Authorization: Bearer <registry-publish-token>" \
  https://intar.dev/registry/v1/cutover/gate

# 2. Prove the gateway itself is drained. plan prints terminal routes,
#    workspace app routes, and browser sessions, and they must all be zero.
ssh root@<gateway-host> /usr/local/sbin/intar-deploy-stargate plan

# 3. Keep the scenario host ENABLED and assert it. The fleet gate is what
#    stops learner placement; the host stays enabled so the administrator
#    proof run in step 4 can be placed.
curl -sS -X PATCH -H 'content-type: application/json' \
  -d '{"disabled":false}' \
  https://intar.dev/api/organizations/<orgId>/runners/<runnerId>

# 4. Stage the immutable artifacts here, while the plane is open. See step 3.
#    Build and upload only: the tools build lane makes no plane call.

# 5. Do NOT flip maintenance here. The cutover lane owns the close: it runs
#    its preflight while the plane is still open, then deploys the worker with
#    maintenance on, which fences /api/* and /registry/*. That is the first
#    action of step 4.
```

With the gate drained and the host enabled, and the plane still open, a
learner start already answers `503 runtime_cutover_drained`, so no learner VM
is placed while the proof configuration is in place. This step ends with the
plane open and the fleet drained; step 4 closes the plane.

The host enable call is the item that is easy to get wrong: it is an
`/api/*` request, so once maintenance is `on` it answers the JSON 503 and the
host can no longer be enabled from CI. Enable it in this step.

Then confirm the host is empty: the desired state has no non-absent VM, the
actual state has no VM, and artifact archival and teardown have completed. The
full drain procedure is in the
[scenario host and jailer](./scenario-host-jailer/) runbook.

## Step 2: back up matching state

Do this before any migration, and record every identifier.

```sh
# Gateway: the deploy script stores binary, config, drop-in, and the database
# snapshot it takes with the SQLite backup API, plus SHA256SUMS, under
# /var/backups/intar/stargate/<backup-id>. Do not copy routes.sqlite3 with cp.
ssh root@<gateway-host> /usr/local/sbin/intar-deploy-stargate plan
# apply prints the backup id it captured; record it.

# Agent state on the scenario host. The state is one SQLite database, at
# /var/cache/intar-agent/state/intar-agent/intar-agent.sqlite3 (the unit sets
# XDG_STATE_HOME=/var/cache/intar-agent/state). The host does not need the
# sqlite3 CLI: Python's sqlite3 module is present, and the read-only mode plus
# the backup API give a consistent snapshot. Assert integrity before you rely
# on it:
ssh root@<host> 'python3 -' <<'PY'
import sqlite3, sys

source = "/var/cache/intar-agent/state/intar-agent/intar-agent.sqlite3"
target = "/root/intar-agent-state-<date>.sqlite3"
src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
dst = sqlite3.connect(target)
src.backup(dst)
if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
    sys.exit("integrity check failed")
dst.close()
src.close()
PY
ssh root@<host> sha256sum /root/intar-agent-state-<date>.sqlite3
# Do not tar the cache or the jail tree. /var/cache/intar-agent holds the
# image cache and the jail chunk store, which are large and are rebuilt in
# place; archiving them risks a multi-terabyte copy and is unnecessary.
# Keep the config and the installed binaries with the release record.
```

For D1, record the current bookmark before the web deploy. Time Travel needs
that exact bookmark to restore matching state.

## Step 3: build and stage the immutable artifacts

Everything here runs while the plane is still open and the fleet gate is
already drained, so a learner start answers `503 runtime_cutover_drained` and
no learner run is placed. Nothing in this step changes what the product
serves; it stages the release.

1. Guest tools: the run gate is already `drained`. Run the `tools-build`
   operation of `image-ops.yml`. It builds the Kino binary and the tools disk,
   uploads the three immutable objects, and byte-verifies them by
   re-downloading. It makes no control-plane call, so it succeeds against the
   old ABI 2-rejecting plane. It leaves the `candidate` channel in R2, which
   the old plane never reads. Do not run promotion here: it needs the new
   plane.
2. Do not publish images here. An ABI 2 catalog manifest is validated by the
   plane, and the old plane rejects ABI 2, so image publication belongs after
   the new web and runtime are installed. See step 4.

### Note on catalog content

The bundle carries whatever Course source it is given, and the server
replaces the whole scope on publish. Rebuild from the live Course source, not
from a sample or fixture tree. `content/courses` holds `linux-operations` in
this repository; if the live catalog serves a different course set, publish
that same live content or do not publish a catalog at all in this window.
Confirm the course and scenario set before and after the publish, because a
publish replaces the scope rather than merging.

## Step 4: install, then bring the release to service

Order matters. The runtime components must all be installed before the plane
opens, because the release has no compatibility path. While maintenance is
`on`, `/api/*` and `/agent/*` answer the JSON 503 and `/registry/*` answers
the maintenance page, so registry work cannot run in the middle of this step.

1. Web: run `website.yml` with `operation=deploy`, `maintenance=on`, and
   confirmation `DEPLOY WEB RELEASE`. Its plan job runs while the plane is
   still open, so
   it takes the pin from a guest-tools build of this exact revision and
   enforces the fleet drain gate, and the deploy job then installs the worker
   with the ABI 2 static pin and maintenance `on`, which closes the fence. The
   generated D1 migration is applied after the maintenance fence is proven,
   inside the same run.
   Before the production apply, the same run rehearses every pending generated
   migration on a disposable D1 database built at the applied prefix that
   production reports, seeds the rows that must survive, applies the pending
   set, and verifies the full committed schema. The in-repository tests prove
   the apply logic against an in-memory database, but only this rehearsal
   proves the real transition.
2. Gateway:
   `intar-deploy-stargate apply <tag> <archive-sha256> <binary-sha256>`.
   It stops the service, then requires a drained gateway: zero terminal
   routes, zero workspace app routes, and zero browser sessions, read from
   the gateway database. It installs, starts, waits for readiness, and
   verifies the migrations and the host routing. `plan` prints those three
   route counts, so prove zero before you apply.
3. Scenario host runtime and builder, under the fence:
   `sudo crates/intar-jailerd/deploy/install.sh`, then
   `sudo /usr/lib/intar/intar-jailerd-self-test`, then the agent `--doctor`,
   and install the builder package. Keep the host enabled: the fleet gate,
   not the host switch, is what stops learner placement, and the
   administrator proof needs an enabled host. Keep the host disabled only on
   a hash, seccomp, Landlock, cgroup, accounting, template, or helper failure.
   `crates/intar-jailerd/deploy/uninstall.sh` reverses the package.
4. While the plane is fenced the bridge is closed by design: maintenance
   answers every `/api/*` and `/agent/*` request with the JSON 503, so the
   agent cannot reach the bridge and that is expected, not a failure. Run the
   local doctor here as a hardware and configuration check only; the
   platform-level bridge probe happens after the reopen in step 7.
5. Open the plane: run `website.yml` with `operation=deploy`,
   `maintenance=off`, and the same confirmation. It releases the revision main names and returns the
   product to service, and the fleet stays drained.
6. Registry work, now that the plane is open and the fleet gate is still
   `drained`. Publish the candidate image catalog with Kino ABI 2 and wait for
   its builds to report ready, then run the `tools-promote` operation of
   `image-ops.yml` with the
   expected candidate digest to warm every host and move the tools to the
   `stable` channel, and only then promote the image catalog, which requires
   stable tools ready. Every call goes to `/registry/*`, which the fence
   covered until step 5, so this is the first point where any of it can run.
   Publishing the catalog replaces its scope, so use the live Course source
   and confirm the set.
7. Host-side proofs with the plane open: the jailerd self-test and the agent
   `--doctor` already ran in step 2; re-run them if any component changed.
   Then create the test VMs, run the proofs, and delete the VMs inside this
   window. A scenario start that goes through the product needs the plane
   open, which step 5 provided, and the administrator path needs the host
   enabled, which step 2 kept. The fleet gate stays drained, so no learner
   run is placed.
8. Run the built-in browser production check from the benchmark runbook and
   confirm the login, run, and terminal flows. Rescue and verify one Klustered
   run, including K3s readiness, and play back one SSH recording. While the
   gate is drained a learner start answers `503` `runtime_cutover_drained`;
   the existing `isAdmin` to `allowDrainedAdminProof` path admits an
   administrator-started run for exactly this proof.
9. Only then reopen the fleet: set the cutover gate to `open`, then confirm
   the host reports healthy and the fleet accepts a normal start.

Do not push to `main` while this window is open. A `main` push releases
through the deploy job of the website lane, so a push during the window would
release that revision outside this sequence. The `deploy` operation is the
deliberate path, and it is the only one that may close or reopen the plane.

## Step 5: roll back with matching state

1. Close the gates again, exactly as in step 1.
2. Gateway: `intar-deploy-stargate rollback <backup-id>`. It verifies the
   backup, requires the drained state, takes its own safety backup, and
   restores the binary, config, drop-in, and database together.
3. Web: restore the worker that matches the D1 bookmark you recorded, and
   restore the bookmark when the migration must be undone. An old worker
   against a migrated schema is not a rollback.
4. Agent state: restore `/var/cache/intar-agent` and `/var/lib/intar/jails`
   from the archive, then reinstall the previous package if the runtime moved.
5. Reopen in the step 4 order and repeat the verification.

## Web release lane

`.github/workflows/website.yml` releases the web part of this sequence
through its `deploy` operation. It is also the lane that releases every
routine `main` commit: a push waits for that run's own checks, and the deploy
job then installs the artifact those checks produced.

A `workflow_dispatch` is the deliberate path, and it is the only path that
may ask for more than a routine release:

- `maintenance=auto` follows pending migrations. A push can ask for nothing
  else: it can not close the plane and it can not ask for the delete
  campaign.
- `maintenance=on` closes the plane for a deliberate runtime release, and
  `maintenance=off` returns the release to service. Both require the
  confirmation `DEPLOY WEB RELEASE`.
- `registry_cleanup_mode` selects the collector mode, and `delete` is
  dispatch-only.

Both paths release the revision that `main` names when the run starts, so a
release never names a revision other than the one the lane runs on. The
runtime pin follows the same split: a routine release keeps the promoted pin
from `guest-tools/scenario/stable.json`, because that is what the fleet is
already running, while a deliberate closed release takes the tools built from
this exact revision, because that release changes the runtime contract.

Before the deploy it refuses to continue while a gate it can read is still
open:

1. When maintenance is not `auto`, the fleet-wide runtime cutover gate must
   answer `drained` with `active_desired_vms` zero. The deploy lane reads
   `/registry/v1/cutover/gate` before it downloads anything. This read only
   works while the plane is open, because the registry sits behind the
   maintenance fence, and the lane says so when the answer is fenced.
2. The deployed revision is proven live: the active version's `workers/tag`
   must carry the release revision, so a return to service can not open the
   plane on an older worker.
3. The D1 drain audit must report zero active scenario runs, zero non-uploaded
   run artifacts, and the `image_cutover` gate state `drained`, for a release
   that holds the plane closed and for the return to service. The enabled-host
   count is recorded as evidence, not enforced:
   the host stays enabled on purpose so the administrator proof can be placed.

What the lane cannot read, and what an operator therefore confirms by hand:
the gateway route drain (`intar-deploy-stargate plan` reports zero terminal
routes, zero workspace app routes, and zero browser sessions), the scenario
host package install and its self-test, the image readiness in the host cache,
and the runtime version on every host. The confirmation prompt is not proof of
those gates; the recorded `plan` output and the host evidence are.

## Honest bounds

The web steps are automated by the lane above; the gateway, scenario host,
image, and runtime steps are not. There is no rollback path for the scenario
host package in `.github/workflows/release.yml`, which publishes artifacts
only, so the host steps are manual. The latency targets stay unproven until a
complete benchmark campaign passes the acceptance gate. No part of this
sequence has run in this repository: the gate endpoints, the backup
identifiers, and the timings are to be confirmed during the window.
