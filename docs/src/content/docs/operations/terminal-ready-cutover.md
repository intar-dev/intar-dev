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
4. Keep the control plane in maintenance until the candidate is proven. A
   normal web deploy bakes `CONTROL_PLANE_MAINTENANCE=off` into the generated
   config, so deploy the candidate with a temporary config that keeps it
   `on`.

## Step 1: close the gates

Order matters, because of the maintenance fence. When maintenance is `on`,
`handleMaintenanceMode` (`apps/web/src/maintenance.ts`) answers every
`/api/*` and `/agent/*` request with the JSON 503, and every other path,
including `/registry/*`, with the HTML maintenance page. No operator bypass
reaches the application. The registry that fronts the cutover gate is
therefore inside the fence, so the fleet drain must be applied while the
control plane is still open. Close the plane first and the drain can no
longer be set from CI.

Every step except the last talks to `/api/*` or `/registry/*`, so every one of
them must run while the plane is still open. Maintenance is the last switch,
not the first.

```sh
# 1. Runtime cutover gate: block new scenario placement fleet-wide. The lane
#    sets the state and polls until the registry reports drained with
#    active_desired_vms zero.
gh workflow run image-gate.yml --ref main \
  -f state=drained -f confirmation='SET IMAGE GATE DRAINED'
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

# 4. Publish the registry-dependent artifacts here, while the plane is open:
#    the image catalog and the guest tools candidate and promotion. The same
#    work may instead run after step 4 of this sequence returns the plane to
#    service, as long as the fleet gate stays drained.

# 5. Control plane maintenance, and prove it. This is the close, and it fences
#    /api/* and /registry/* until the return to service.
#    Set CONTROL_PLANE_MAINTENANCE=on in the worker config for this deploy,
#    then check the probe: it must answer 503 with code "maintenance".
curl -sS -H 'Accept: application/json' -o /tmp/maintenance.json \
  -w '%{http_code}\n' https://intar.dev/api/control-plane-maintenance-probe
cat /tmp/maintenance.json
```

With the gate drained, the host enabled, and the plane still open, a learner
start already answers `503 runtime_cutover_drained`, so no learner VM is
placed while the proof configuration is in place.

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

# Agent state and jail data on the scenario host.
ssh root@<host> tar -C / -czf /root/intar-agent-state-<date>.tgz \
  var/cache/intar-agent var/lib/intar/jails
ssh root@<host> sha256sum /root/intar-agent-state-<date>.tgz
```

For D1, record the current bookmark before the web deploy. Time Travel needs
that exact bookmark to restore matching state.

## Step 3: deploy with traffic closed

1. Gateway: `intar-deploy-stargate apply <tag> <archive-sha256> <binary-sha256>`.
   It stops the service, then requires a drained gateway: zero terminal
   routes, zero workspace app routes, and zero browser sessions, read from
   the gateway database. It installs, starts, waits for readiness, and
   verifies the migrations and the host routing. `plan` prints those three
   route counts, so prove zero before you apply.
2. Web: deploy the worker with `tools/deploy/deploy-web.sh` and a
   `CONTROL_PLANE_MAINTENANCE=on` config. The deploy validates the expected
   mode and probes the maintenance endpoint. Do not deploy with the generated
   `off` config in this step.
3. Scenario host runtime: `sudo crates/intar-jailerd/deploy/install.sh`, then
   `sudo crates/intar-jailerd/deploy/intar-jailerd-self-test.sh` for the
   privileged proof, and the agent doctor. Keep the host disabled on any hash,
   seccomp, Landlock, cgroup, accounting, template, or helper failure.
   `crates/intar-jailerd/deploy/uninstall.sh` reverses the package.
4. Images: publish the candidate catalog with Kino ABI 2, and wait for every
   required image to report ready in the host cache. This step and the
   candidate distribution in `guest-tools-deploy` both talk to `/registry/*`,
   which the maintenance fence covers. Do them either before maintenance is
   `on`, or after the cutover deploy returns the plane to service while the
   fleet gate is still drained. While maintenance is `on` they return the
   maintenance page, so a run started then fails closed.

Do not start a web-worker deploy from a branch push. A partial deploy on main
would replace the worker with a maintenance-off config while the runtime is
still closed. Coordinate the branch so the web action runs only in this
window, with the maintenance config and the complete release manifest.

## Step 4: verify, then reopen

The proof window is bounded and single-pass: the runtime version is deployed,
the VMs are created, tested, and deleted, and only then does the web release
return the product to service. Maintenance `off` is the last deploy action,
not an early one.

1. With maintenance still `on`, deploy the runtime version: the agent and
   jailerd package and the gateway. Run the host-side proofs: the jailerd
   self-test and the agent `--doctor`. Image and guest-tools publication
   happens in step 3, before the close, or after this cutover with the fleet
   still drained, because the registry is fenced here.
2. Create the test VMs, run the proofs, and delete the VMs inside this window.
   A scenario start that goes through the product needs the plane open,
   because `/api/*` is fenced while maintenance is `on`. The administrator
   path in step 3 needs the host enabled, which step 1 already asserted, and
   the plane open, which step 4's return to service provides. The fleet gate
   stays drained throughout, so no learner run is placed.
3. Run the built-in browser production check from the benchmark runbook and
   confirm the login, run, and terminal flows. Rescue and verify one Klustered
   run, including K3s readiness, and play back one SSH recording. While the
   gate is drained a learner start answers `503` `runtime_cutover_drained`;
   the existing `isAdmin` to `allowDrainedAdminProof` path admits an
   administrator-started run for exactly this proof.
4. Return the product to service: deploy the web release with maintenance
   `off`. This is the last deploy action of the window.
5. Only then reopen the fleet: set the cutover gate to `open`, then enable the
   host (`{"disabled":false}`).
6. Confirm the host reports healthy and the fleet accepts a normal start.

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

## Web cutover lane

`.github/workflows/website-cutover.yml` is the manual lane that performs the
web part of this sequence. It runs only on `workflow_dispatch` against `main`
with the `CUTOVER WEB RELEASE` confirmation, and it refuses to continue while
any gate it can read is still open:

1. The fleet-wide runtime cutover gate must answer `drained` with
   `active_desired_vms` zero. The lane reads
   `/registry/v1/cutover/gate` before it downloads anything.
2. The control plane must answer the maintenance probe with `503` and code
   `maintenance`, and maintenance stays on for the candidate deploy. A normal
   web deploy bakes `CONTROL_PLANE_MAINTENANCE=off`, so the lane pins the
   maintenance config for the whole window. Opening the control plane is a
   separate, later action in step 4, after the fleet proof, and it is the
   precondition for any browser probe.
3. The D1 drain audit must report zero active scenario runs, zero non-uploaded
   run artifacts, and zero enabled agent hosts.

What the lane cannot read, and what an operator therefore confirms by hand
before the dispatch: the gateway route drain (`intar-deploy-stargate plan`
reports zero terminal routes, zero workspace app routes, and zero browser
sessions), the scenario host package install and its disable switch, the image
readiness in the host cache, and the runtime version on every host. The
confirmation prompt is not proof of those gates; the recorded `plan` output
and the host evidence are.

## Honest bounds

The web steps are automated by the lane above; the gateway, scenario host,
image, and runtime steps are not. There is no rollback path for the scenario
host package in `.github/workflows/release.yml`, which publishes artifacts
only, so the host steps are manual. The latency targets stay unproven until a
complete benchmark campaign passes the acceptance gate. No part of this
sequence has run in this repository: the gate endpoints, the backup
identifiers, and the timings are to be confirmed during the window.
