---
title: Personal metal release
description: Retire the old fleet, install the new release, and open registration and admission in separate steps.
---

This release has no compatibility mode. Every server must use a new host ID
and a fresh enrollment credential. Keep the old host rows: runs, builds, and
artifacts refer to those IDs. An old row with null scope cannot authenticate.
Organization membership, courses, private content, and build ownership remain.
Hosts no longer belong to organizations.

The command is `bun tools/deploy/release-personal-metal.ts`. It uses the existing
web deploy, collector hold, generated migration, and host removal mechanisms.
It does not install packages on a server or change the gateway. Do not run it
until the matching web, gateway, agent, builder, and guest-tools artifacts are
ready. These commands change production when an operator runs them with
production credentials. The implementation tests use local fixtures only.

## Run through Website CI

Use the existing Website workflow for the staged release. Before pushing this
change, set the **repository** variable `PERSONAL_METAL_ROLLOUT=active`. An
environment variable is too late for the job guard. While this value is active,
normal push and manual `operation=deploy` runs can validate and build, but their
production jobs cannot run. Metal actions require the active guard.

If Website was disabled before the push, enable it only after the guarded
workflow reaches `main`. Stop or finish any old Website deployment first; a new
workflow file cannot change a run that already uses the old file. Keep the guard
active through the deferred test period. Do not dispatch the separate image
operations gate-open or collector-release actions during this hold.

Finish package releases and the matching guest-tools `tools-build` run first.
Then record the full `main` commit SHA and keep `main` at that revision for all
three metal actions. Each dispatch compares `metal_revision` with its own
`github.sha` and refuses a mismatch. Do not make version commits between actions.

Before `metal-deploy`, keep admission drained and confirm the old workloads are
empty. Upgrade the gateway first, with routes and sessions drained. Then stop
the old agent and builder services, verify that no old VMs remain, and keep the
services stopped. Save the host and gateway output with the backups. Continue
with web retirement only after these checks pass.

```sh
repo=intar-dev/intar-dev
release_sha=FULL_40_CHARACTER_MAIN_COMMIT_SHA

# Only after the guarded workflow is on main, if Website is disabled:
gh workflow enable website.yml --repo "$repo"

gh workflow run website.yml --repo "$repo" --ref main \
  -f operation=metal-deploy \
  -f metal_revision="$release_sha" \
  -f confirmation='DEPLOY WEB RELEASE'
```

Leave `maintenance=auto` and `registry_cleanup_mode=preserve` at their defaults.
The workflow selects maintenance on for `metal-deploy` and off for the two open
actions. It uses the normal validation, UI smoke, build artifact, guest-tools
verification, configuration checks, runtime secrets, and pending-migration
rehearsal. It records a D1 bookmark before retirement. The metal command owns
migration, deployment, collector hold, and gate changes. All normal deployment
and collector cleanup steps are excluded, including failure cleanup. The runtime
secret file is still removed after failure. This path requires the existing
collector; it does not bootstrap a new collector or replace its deployed version.

Wait for `metal-deploy` to finish successfully. Record its run ID and attempt:

```sh
gh run list --repo "$repo" --workflow website.yml --commit "$release_sha"
deploy_run_id=SUCCESSFUL_METAL_DEPLOY_RUN_ID
gh run watch "$deploy_run_id" --repo "$repo" --exit-status
attempt=$(gh run view "$deploy_run_id" --repo "$repo" --json attempt --jq .attempt)
gh run download "$deploy_run_id" --repo "$repo" \
  --name "personal-metal-${release_sha}-${deploy_run_id}-${attempt}" \
  --dir ./metal-evidence
```

The artifact contains `deploy.json`, the original build identity, the verified
guest-tools pin, and release diagnostics. Metal evidence and the initial web
build are retained for 90 days, subject to repository retention policy. Keep a
separate copy for the release record. Evidence is uploaded after failure too;
failed runs are not accepted as the source for an open action.

Before the metal command can change production, CI also uploads an immutable
`personal-metal-inputs-<SHA>-<run-ID>` artifact with the build receipt and pin.
For recovery, use a fresh dispatch at the same revision and name the failed or
completed prior deploy run. CI restores that run's original inputs, including
inputs whose build came from an earlier recovery source:

```sh
prior_deploy_run_id=PRIOR_METAL_DEPLOY_RUN_ID
gh workflow run website.yml --repo "$repo" --ref main \
  -f operation=metal-deploy \
  -f metal_revision="$release_sha" \
  -f metal_deploy_run_id="$prior_deploy_run_id" \
  -f confirmation='DEPLOY WEB RELEASE'
```

Do not use GitHub's rerun operation for metal actions. They require attempt 1,
and metal build uploads cannot overwrite an earlier artifact. A recovery source
must have its immutable inputs artifact; if failure occurred before that upload,
this run did not enter the metal command. After recovery succeeds, use its run ID
for opening. D1 binds retirement to the original build ID, build digest, and
injected tools pin hash. A fresh build or pin cannot recover or open that
operation, even at the same revision. Recovery does not deploy again after
retirement has committed, and does not retire the fleet twice.

Before opening platform registration, complete the old-service, VM-removal,
and gateway checks in **Open platform registration** below. Save their actual
results in `fleet-checks.json`, including the full release SHA and exactly the
old IDs from `deploy.json`. Keep supporting host and gateway output with your
release record. Then dispatch:

```sh
gh workflow run website.yml --repo "$repo" --ref main \
  -f operation=metal-open-platform-registration \
  -f metal_revision="$release_sha" \
  -f metal_deploy_run_id="$deploy_run_id" \
  -f metal_checks="$(cat fleet-checks.json)" \
  -f confirmation='DEPLOY WEB RELEASE'
```

Both open actions download the original successful `metal-deploy` evidence and
web build. They check the source workflow, event, branch, full revision, artifact
identity, and SHA-256 digest. They reuse its guest-tools pin. The release command
also compares the retirement evidence with D1 before it can open a gate. A new
build from an open-action run does not replace the original release artifact.

**Current stop: do not run `metal-open-admission`.** The real VM/NAT test is
postponed. After platform registration opens, install and enroll the fresh
platform agents and builders. Personal registration and scenario admission stay
drained, and the collector stays held. Record VM/NAT results as **deferred**.
Package, unit, Worker, and UI checks do not replace those results.

Only after the five actual personal-host tests and the fresh-fleet checks below
pass, upload their report as `personal-metal-proof.evidence` at the root of an
artifact from a verification run in this repository at the same commit SHA.
Record its artifact ID. Set the proof fields in `fleet-checks.json` from those
actual results. Then use the original deploy run ID:

```sh
# Future action only: all required live checks must have passed.
proof_artifact_id=ACTUAL_TEST_REPORT_ARTIFACT_ID
gh workflow run website.yml --repo "$repo" --ref main \
  -f operation=metal-open-admission \
  -f metal_revision="$release_sha" \
  -f metal_deploy_run_id="$deploy_run_id" \
  -f metal_checks="$(cat fleet-checks.json)" \
  -f metal_proof_artifact_id="$proof_artifact_id" \
  -f confirmation='DEPLOY WEB RELEASE'
```

CI verifies and downloads the report, sets only its local evidence path, and
passes the supplied proof flags to the release command unchanged. Missing or
false proofs cannot open admission. The command stores the report and its hash
with the action evidence. Keep the artifacts from all stages. Remove the rollout
guard only after admission has opened and the release has been checked. No
workflow action removes the guard automatically.

The following sections describe the same phases and their direct CLI commands.

## Prepare

1. Stop other deploys for the maintenance window. Use one operator and one
   release revision throughout the window.
2. Record a D1 Time Travel bookmark. Back up the gateway database and the old
   server state. Keep the matching old binaries with those backups.
3. Build the web release with the normal build process. Prepare two built
   Wrangler JSON configurations for the same artifact and D1 database. Set
   `CONTROL_PLANE_MAINTENANCE` to `on` in one and `off` in the other. Include
   the existing `HOST_RUNTIME` namespace and collector binding. Do not use a
   new Durable Object namespace: the old objects must be retired.
4. Prepare the normal deploy secrets JSON file. It must include
   `CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET`. Keep the file private.
5. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `GITHUB_SHA`,
   `GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT`, as required by `deploy-web.sh`.
   Set `CLOUDFLARE_D1_TOKEN` if the database uses a separate token. Set
   `REGISTRY_CLEANUP_MODE` to the installed collector mode (`report-only` or
   `delete`). Rehearse the generated migrations on a disposable D1 database
   with `tools/database/rehearse-removal-migration.ts` before production.

6. Keep admission drained. Upgrade the matching gateway with empty routes and
   sessions. Stop the old agents and builders, verify that all old VMs are gone,
   and keep those services stopped through retirement.

## Close and retire

```sh
bun tools/deploy/release-personal-metal.ts deploy \
  /secure/release/wrangler-maintenance.json "$CLOUDFLARE_DATABASE_ID" \
  /secure/release/secrets.json /secure/release/metal-evidence
```

The command closes `image_cutover`, `personal_metal_registration`, and
`platform_metal_registration`, holds
the registry collector, and deploys the web artifact with maintenance on.
It allows 60 seconds for old requests to finish, checks the maintenance
response, and refuses to continue while a registry writer is still open.
It then applies the generated migrations and retires the complete old fleet
in one database transaction. A failed transaction rolls back.

Retirement revokes credentials and pending enrollments, ends executions and
active runs, clears old route cleanup IDs (including completed and failed runs),
fails unfinished builds (including queued builds with no assigned host), removes desired state and its dispatch
outbox, releases resource reservations, clears image preparation grants,
seals VM artifact writes, and removes terminal attach secrets. Stored
artifacts and incomplete upload records remain as evidence. Retirement does
not mark incomplete uploads as successful and does not prove physical VM
removal. User placement and `owner_removal_id` remain unchanged.

After the transaction, the command calls the existing host removal mechanism
for every old ID through a machine-authenticated maintenance action. Each
object must clear its old recovery state, sockets, and alarm. The command
checks the maintenance fence again and writes `deploy.json`. A failed object
retirement leaves all admission gates closed.

D1 stores recovery evidence in `runtime_operation_gates.evidence_json` on the
`personal_metal_retirement` row. The fleet retirement transaction stores the
old host IDs, original lease deadline, retirement time, migration proof, database
ID, release revision, and operation ID. For CI, the evidence also stores the
build artifact ID, digest, and injected guest-tools pin hash. These values are
part of the operation ID, together with the database ID and release revision.
The workflow supplies `PERSONAL_METAL_RELEASE_INPUTS_FILE` with its saved
`release.json`. Supply that same file when recovering a CI operation with the
direct CLI, and retain the matching pinned configuration. The final transaction stores the runtime
completion time and completion marker together.

If the command fails, rerun `deploy` with the same database and `GITHUB_SHA`.
If maintenance blocks the collector hold endpoint with HTTP 503, the command
requires a live maintenance response and a paused, idle collector in D1 before
it proceeds. It does not open a maintenance exception for the collector.
After database retirement, a retry uses the saved old host IDs and repeats
their runtime cleanup. It does not repeat database retirement. After completion,
a retry reads and verifies the saved evidence and can restore a missing
`deploy.json`, even if the prior D1 commit response was lost. It does not deploy,
change gates, or retire newly enrolled servers. A different revision, database,
or operation ID is refused. Keep existing action evidence; the CLI refuses to
overwrite it.

The two gate-opening actions also save their result in D1 in the same
transaction that opens the gate. If the response or local action file is lost,
repeat that action with the same release inputs. The command returns the saved
result without deployment, collector calls, or gate changes. This result records
the completed action; an operator can have closed a gate since that action.

The host-table rebuild in migration 0023 must run through
`apply-generated-migrations.ts`. That tool defers foreign-key checks and
moves inbound references for the duration of the atomic batch. It runs the
generated schema statements unchanged, then restores the exact host IDs.
This prevents `DROP TABLE` from applying CASCADE or SET NULL to run history.
Do not apply this populated-table migration with a statement-by-statement
Drizzle HTTP migration command.

## Open platform registration

Verify that the gateway upgrade and old-service shutdown from the preparation
step are complete. Confirm again that all old VMs are gone and gateway routes
and sessions are empty. Record the old host IDs from `deploy.json` in a checks file:

```json
{
  "revision": "the-exact-GITHUB_SHA",
  "stoppedHostIds": ["old-agent-id", "old-builder-id"],
  "gatewayRoutes": 0,
  "gatewaySessions": 0,
  "hosts": []
}
```

These are operator checks. Record the supporting service, VM inventory, and
gateway output with the release evidence. For the gateway, use
`intar-deploy-stargate plan` to read the route and session counts. A JSON
assertion alone does not measure a remote machine.

```sh
bun tools/deploy/release-personal-metal.ts open-platform-registration \
  /secure/release/wrangler-open.json "$CLOUDFLARE_DATABASE_ID" \
  /secure/release/secrets.json /secure/release/metal-evidence \
  /secure/release/fleet-checks.json
```

This action verifies the matching database, release revision, old host IDs,
retirement state, and foreign keys. It deploys the same release with
maintenance off and then opens platform registration only. Personal registration and scenario
admission remain drained, and the collector remains held. Install and enroll fresh platform
agents and builders through the new enrollment flow. This bootstrap step does
not require the personal metal proofs below. Personal registration stays closed
until both fleet checks and personal metal proofs pass. Do not copy an old host
ID or credential.

## Open admission

Run the jailer self-test and agent doctor on the new servers. Verify images,
guest tools, the host relay, terminal access, and artifact recording on the
matching release. Keep admission drained during the administrator proof run.

Before opening production personal registration, run all five personal metal
checks on the exact `GITHUB_SHA` release. Use a staging environment with the
matching web, installer, agent, gateway, and guest-tools artifacts. Staging can
allow enrollment for this proof while production personal registration stays
closed. Put the staging personal host behind NAT, with no public inbound port
forwarding to the host.

1. `installerPassed`: install on a fresh host with the published installer.
   Record the installer, service startup, and doctor results.
2. `ownershipPassed`: verify the owner can enroll and manage the host. Verify a
   second account cannot manage it or access the owner's workloads and content.
3. `browserNatPassed`: open and use a browser terminal through the gateway to a
   VM on the NAT host.
4. `nativeSshNatPassed`: connect with a native SSH client through the gateway to
   that VM.
5. `workspaceAppsNatPassed`: open a workspace app through its gateway URL and
   verify HTTP and WebSocket traffic to the NAT host.

Save the supporting results in one report or evidence archive. Include the
release revision, staging environment, NAT setup, commands, and test output for
each check. These are operator proofs; setting JSON fields does not run the
tests. Set each field to `true` only after its check passes.

Add the checked platform hosts and `personalMetalProof` to the checks file:

```json
{
  "revision": "the-exact-GITHUB_SHA",
  "stoppedHostIds": ["old-agent-id", "old-builder-id"],
  "gatewayRoutes": 0,
  "gatewaySessions": 0,
  "hosts": [
    {"id":"new-agent-id","role":"agent","agentVersion":"installed-version","doctorPassed":true,"imagesReady":true,"gatewayPassed":true},
    {"id":"new-builder-id","role":"builder","agentVersion":"installed-version","doctorPassed":true,"imagesReady":true,"gatewayPassed":true}
  ],
  "personalMetalProof": {
    "revision": "the-exact-GITHUB_SHA",
    "installerPassed": true,
    "ownershipPassed": true,
    "browserNatPassed": true,
    "nativeSshNatPassed": true,
    "workspaceAppsNatPassed": true,
    "evidencePath": "/secure/release/staging-personal-metal-proof.tar.gz"
  }
}
```

```sh
bun tools/deploy/release-personal-metal.ts open-admission \
  /secure/release/wrangler-open.json "$CLOUDFLARE_DATABASE_ID" \
  /secure/release/secrets.json /secure/release/metal-evidence \
  /secure/release/fleet-checks.json
```

The command requires a fresh platform agent and builder. It checks their IDs,
roles, reported versions, enrollment time, credentials, sessions, heartbeat,
and inventory time in D1. It releases the collector and repeats the live
host checks against the database clock in the transaction that opens both personal registration and
scenario admission. Before releasing the collector, it requires all five
personal proof fields to be exactly `true`, verifies the proof revision, and
copies the nonempty supporting file into the action evidence directory. It
saves the attestation as `personal-metal-proof.json`, with the copied evidence
path and SHA-256 hash. `open-admission.json` also contains this attestation.
A missing, false, or invalid proof, or a failure to save its evidence, leaves
personal registration and admission closed. Keep the entire evidence directory,
including all three action records and the copied supporting evidence.

If a deploy or network response is uncertain, inspect the saved deployment
and D1 gate state before retrying. There is no automatic rollback or reopen.
To roll back, close maintenance and restore the matching D1 bookmark, gateway
state, and binaries together. Do not run an old worker against the new schema.
