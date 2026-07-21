# Standalone Workshops v1 rollout

This is the production cutover and pilot evidence runbook for standalone Intar
Workshops. It deliberately keeps Courses and Scenarios available on their
existing APIs and uses the organization feature flag as the final exposure
boundary.

The production Worker is `intar-dev`, the D1 database is
`intar-dev-app-20260709`, and the only checked-in production website is
`https://intar.dev`. There is no staging Worker in this repository. Treat every
production proof as a canary operation with an explicit roster.

## Hard gates

Do not enable `workshops_enabled` for any human pilot organization until every
item below has evidence attached to the release ticket.

- The pull request's **Website** workflow is green, including **Test and build**
  and **UI visual, accessibility, and smoke**. The Rust workspace checks are
  green as well.
- The checked-in workshop-builder binary, service unit, and concrete
  `WorkshopExecutionBackend` adapter are installed on a trusted Linux/KVM
  builder and have completed a publication there. Unit tests and a fake
  backend do not prove the guest workflow.
- The dedicated Debian 13 image has passed a real KVM proof for Docker,
  privileged containers, Talos-in-Docker, Cilium/eBPF, every canonical
  `catch-up-*.sh` and `verify-*.sh`, sanitization, sealing, and cold boot.
- Production host-failure detection invokes
  `recoverWorkshopRuntimesFromFailedHost`, and a controlled stale-host drill
  proves the deployed caller rather than only the unit-tested function.
- The learner can renew an active assistance grant from 15 to at most 30
  minutes through a deployed API/UI path. The library function alone is not an
  operational path.
- Lobby capacity exposes enough evidence to identify allocation failures per
  runner, including missing images and CPU, memory, and worst-case disk. The
  aggregate seat count alone is insufficient for a go decision.
- Scenario and workshop admission share one atomic resource-allocation fence;
  simultaneous starts cannot each reserve the same reported CPU, memory, or
  disk headroom.
- Every Intar workshop API request rechecks current organization membership as
  well as the pinned session roster. Workspace-app proxy requests instead use
  the bounded, route-specific browser session described below: explicit route
  teardown revokes it immediately, organization membership removal must revoke
  it before committing, and sign-out alone is bounded by the 15-minute
  route/session expiry.
- Terminal and application creation writes a deterministic route-issuance
  intent before contacting Stargate. The create request has a 30-second client
  deadline and the pending intent has a two-minute recovery lease. Membership
  removal establishes its D1 fence first, cleans every already-recorded route
  and runtime even while an intent is fresh, and keeps the membership fenced
  until a retry either observes the issued route or retires the stale intent
  and deletes its requested route key. This proof assumes Stargate cannot begin
  or commit a create after the two-minute lease; confirm that bounded handler
  behavior during the Stargate canary before enabling an organization.
- A workspace-app bootstrap URL is single-use, expires after 60 seconds, and
  cannot be replayed after exchange by a different or signed-out browser. Each
  later HTTP request and WebSocket handshake must present the opaque,
  route-bound cookie whose digest and expiry Stargate verifies.
- End/cancel and assist revoke are retry-safe across Stargate or desired-state
  failures. A database transition to a terminal state must not make unfinished
  external cleanup impossible to resume.
- Participant projections omit the bodies of unreleased slides, presenter
  notes, unrevealed hints, and solutions; a client-side `released = false`
  marker is not redaction. The asset endpoint applies that same projection as
  its ACL, so a guessed path for an image used only by withheld content returns
  `404` until the referring surface is released to that viewer.
- The participant disk and repository contain the manual verifiers but not
  canonical catch-up/solve scripts or facilitator material.
- The facilitator roster has real live presence, separate technical and
  explain-back state, and per-probe health rather than copying one aggregate
  module status onto every named probe.
- The every-minute production Cron Trigger opens due lobbies at
  `lobby_opens_at`, releases gate modules atomically, and records exactly one
  automatic event. A passing unit test without the deployed trigger is not
  sufficient evidence.
- Participant native SSH and helper resolution/assist renewal have deployed
  API/UI paths, with native SSH remaining participant-only.
- At least two organization runners are healthy, image-ready, and mutually
  independent. After placing two learners, another eligible runner must still
  have one full seat (4000 millicores, 16384 MiB memory, and 102400 MiB disk)
  for the recovery exercise.
- The first-level route origin is configured as `<route-id>.intar.app`, with
  canonical route IDs beginning `wa-`. The zone's existing Universal SSL
  certificate covers these first-level subdomains; do not restore the deeper
  `*.workshop-apps.intar.app` design, which would require a different
  certificate. The protected edge workflow must report the owned wildcard DNS
  record, the exact Tunnel ingress order, and the final cache-bypass rule as
  desired before any workshop route is issued. See Cloudflare's
  [Universal SSL coverage and limitations][universal-ssl].
- A **Stargate production** `plan` run has proved the configured approval mode,
  main-only branch policy, pinned deployment identity, expected host command
  protocol, and all three live route counts. `reviewed` mode requires an
  independent reviewer plus prevent-self-review. `single-operator` mode is an
  explicit exception for a repository with exactly one collaborator, who must
  be an administrator, and no required-reviewer rule; the actor and triggering
  actor must be that sole collaborator. Do not apply if the workflow cannot
  verify every fact for the selected mode.

If any gate is false, leave the feature flag's default `false`, stop the
rollout, and keep Workshops inaccessible. Do not substitute a scenario fleet,
TCG boot, kind fallback, Internet image pull, or manually seeded revision as
release evidence.

## Roles, identifiers, and evidence

Assign one operator to each role before starting:

- release operator: merges the approved commit and watches GitHub Actions;
- database observer: runs read-only D1 checks and records the Time Travel
  bookmark;
- host operator: drains routes, performs the one-time restricted Stargate CI
  bootstrap, and approves the CI-owned rollout;
- facilitator: drives the canary session;
- two learner accounts and one separate helper account, all explicit members
  of the canary organization;
- one non-member or member of another organization for isolation checks.

Record these values without placing cookies, bootstrap tokens, or registry
tokens in the ticket:

```text
release commit:
website production run:
stargate release tag and checksum:
stargate deployment run and backup ID:
stargate rollback run and safety backup ID, if any:
pre-migration D1 bookmark:
canary organization ID and slug:
canary session ID:
facilitator user ID:
helper user ID:
learner user IDs:
runner IDs:
publication ID, content SHA-256, template ID, revision ID:
old/new execution IDs for restore and host recovery:
```

### Single-user commissioning boundary

Before additional identities are enrolled, the sole organization owner may be
rostered as a `participant`. Organization ownership still grants session,
facilitator, and presenter controls, while the participant role grants only
that user's learner workspace, terminal, applications, and progress. It does
not grant helper assistance: a separate helper remains required to claim a
request or receive an assist grant.

This mode can prove one-seat allocation, the learner lifecycle, presentation
controls, checkpoint restore on the same eligible runner, and one route's HTTP
and WebSocket behavior. It cannot satisfy helper-consent isolation,
non-member denial with an independent identity, two-learner host/cookie
isolation, or host-to-host recovery. Keep those acceptance items open and keep
the organization flag off for a general pilot until the full identity and
runner roster above is available.

Store command output, screenshots, browser traces, and host logs in the release
ticket. Redact `cookie`, bearer-token, private-key, and Stargate assertion
values.

## 1. Validate the release candidate

From the repository root, run the same high-level gates used by CI:

```sh
just generate-scenario-wasm
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
bun --cwd website install --frozen-lockfile
bun --cwd website run test
bun --cwd website run build
```

Validate and deterministically bundle the reference workshop:

```sh
cargo run -p intar-workshop-cli -- validate workshops/platform-engineering
cargo run -p intar-workshop-cli -- bundle workshops/platform-engineering \
  --output /tmp/intar-platform-engineering-workshop.tar.gz
sha256sum /tmp/intar-platform-engineering-workshop.tar.gz
```

The `validate` command must report `11 modules, 240 scheduled minutes`. Confirm
the source still contains exactly 85 slides, 85 note files, 11 modules, and the
upstream license:

```sh
test "$(find workshops/platform-engineering/slides -maxdepth 1 -name 'slide-*.md' | wc -l | tr -d ' ')" = 85
test "$(find workshops/platform-engineering/slides/notes -maxdepth 1 -name 'slide-*.md' | wc -l | tr -d ' ')" = 85
test "$(rg -c '^module "' workshops/platform-engineering/workshop.hcl)" = 11
rg -n 'Apache-2.0|1b6fad43551a720b143d7a52799f81c4c89455cb' \
  workshops/platform-engineering/workshop.hcl \
  workshops/platform-engineering/SOURCE.md \
  workshops/platform-engineering/LICENSE
```

The approved pull request must complete `.github/workflows/website.yml`; do not
merge a direct website push to `main`, because that bypasses the pull-request
quality gates and deploys immediately.

## 2. Prepare the feature flag

The Worker binding `FLAGS` points to Flagship app
`12f35c20-55f4-47ee-8b31-b3ad202d1f04`. Create a boolean flag with the exact
key `workshops_enabled`:

- default variant: `false`;
- flag enabled, but with no broad or percentage rule;
- one exact-match rule for the canary organization's D1 `organization.id`;
- match `targetingKey` (the Worker also passes the same value as
  `organizationId`);
- serve `true` only for that exact ID.

Keep the rule absent until the website, D1, Stargate, builder, image, and
prewarm gates below are complete. A disabled or unmatched flag intentionally
returns a non-enumerable `404` from workshop APIs.

Use a dedicated internal canary organization for the live E2E. The intended
human pilot organization remains unmatched until the canary evidence is
accepted. Workshop templates are organization-private, so publish the final
revision again with a token scoped to the human pilot organization after its
flag is enabled.

## 3. Freeze scenario starts and drain the shared runtime

Migration `0005_runtime_executions.sql` creates the generic execution ledger,
`0009_scenario_runtime_data_backfill.sql` copies existing VM, key, artifact,
terminal, and reservation data, and `0010_runtime_artifact_ingestion.sql`
finishes the generic multipart-upload/sealing ledger.
`0015_legacy_scenario_runtime_backfill.sql` repairs scenario state documents
written before the V6 CPU cutover and replays their dependent runtime records.
No scenario may start while either the initial migration sequence or that
forward repair is in flight.

First capture all currently enabled scenarios with a read-only query:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT scenario_id, organization_id, enabled_at FROM vm_scenarios WHERE enabled = 1 ORDER BY organization_id, scenario_id;'
```

Then:

1. In `/admin/scenarios`, disable every enabled public scenario. The backing
   operation is `DELETE /api/admin/scenarios/:scenarioId/enabled`; it does not
   terminate an existing run.
2. In every organization that has a runner, use the **Runners** tab to disable
   each runner. This blocks new organization-private starts while existing
   desired VMs drain. The backing operation is
   `PATCH /api/organizations/:orgId/runners/:runnerId` with
   `{"disabled":true}`.
3. Do not disable or delete builder hosts with an active image build.
4. Ask owners of active scenarios to finish normally. Use the existing end
   flow so routes, recordings, artifacts, and active keys are archived.
5. Wait until all three queries below return no rows:

```sh
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT run_id, user_id, host_id, state FROM scenario_runs WHERE active_key IS NOT NULL ORDER BY created_at;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT h.host_id, json_extract(vm.value, '$.run_id') AS run_id, json_extract(vm.value, '$.vm_name') AS vm_name, json_extract(vm.value, '$.desired_phase') AS desired_phase FROM host_desired_state h, json_each(h.doc_json, '$.vms') vm WHERE json_extract(vm.value, '$.desired_phase') <> 'absent';"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT h.host_id, json_extract(vm.value, '$.run_id') AS run_id, json_extract(vm.value, '$.vm_name') AS vm_name, json_extract(vm.value, '$.phase') AS phase FROM host_actual_state h, json_each(h.report_json, '$.vms') vm WHERE json_extract(vm.value, '$.phase') NOT IN ('absent', 'stopped');"
```

Also require zero live terminal routes before restarting Stargate:

```sh
sudo -u stargate sqlite3 /var/lib/stargate/routes.sqlite3 \
  "SELECT count(*) AS live_terminal_routes FROM routes WHERE expires_at > unixepoch();"
```

Abort if D1 says a run is terminal but a host still reports its VM, if desired
and actual revisions do not converge, or if a live Stargate route has no
accountable run. Preserve the host and route state for investigation; do not
delete rows to make a count reach zero.

## 4. Capture the D1 restore point and pre-migration state

The following commands are read-only. Schema/data changes remain exclusive to
the production GitHub Actions workflow.

```sh
cd website
bunx wrangler d1 time-travel info intar-dev-app-20260709 \
  --config wrangler.jsonc --json

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT id, name, applied_at FROM d1_migrations ORDER BY id;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT count(*) AS scenario_runs, count(DISTINCT user_id) AS users FROM scenario_runs;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT count(*) AS ssh_keys FROM scenario_run_ssh_keys; SELECT count(*) AS artifacts FROM scenario_run_artifacts;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS invalid_scenario_state_json FROM scenario_runs WHERE NOT json_valid(state_json); SELECT count(*) AS invalid_artifact_status_rows FROM scenario_run_artifacts WHERE upload_status NOT IN ('pending','uploaded') OR (upload_status = 'uploaded' AND uploaded_at IS NULL) OR (upload_status = 'pending' AND uploaded_at IS NOT NULL); SELECT count(*) AS invalid_artifact_upload_rows FROM scenario_run_artifact_uploads WHERE next_expected_part <= 0 OR NOT json_valid(uploaded_parts_json);"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'PRAGMA foreign_key_check;'
```

All three `invalid_*` counts must be zero. Invalid scenario state would abort
the JSON-based VM/terminal backfill, invalid multipart state would violate the
new checked upload table, and inconsistent legacy artifact status would be
copied before the new status guards are installed. Stop and investigate any
non-zero count rather than changing production data during the release.

Save the current Time Travel bookmark in the release ticket. Time Travel is an
emergency destructive restore, not the normal rollback mechanism; see the
[Cloudflare D1 Time Travel documentation][d1-time-travel].

## 5. Deploy D1 and the website through GitHub Actions

Merge the already-green pull request to `main` only after the drain is proven.
The push starts `.github/workflows/website-deploy.yml` (**Website production**),
which performs these steps against the exact merge SHA:

1. build the browser scenario validator;
2. install the pinned Bun dependencies;
3. build the deployable Astro artifact;
4. run `bun run db:migrate:production`;
5. run `wrangler deploy` against the built `dist/server/wrangler.json`.

Watch that workflow to completion:

```sh
gh run list --workflow website-deploy.yml --branch main --limit 5
gh run watch <WEBSITE_PRODUCTION_RUN_ID> --exit-status
```

Do not run `bun run db:migrate:production`, `wrangler d1 migrations apply`, or
`wrangler deploy` from an operator workstation. Do not start a second manual
workflow while the push-triggered production run is queued or active.

The expected ordered D1 additions are:

| Migration | Purpose |
| --- | --- |
| `0004_workshops.sql` | organization-private templates, revisions, sessions, roster, workspaces, progress, help, assist grants, and append-only events |
| `0005_runtime_executions.sql` | generic executions, VMs, artifacts, terminal sessions, active slots, resource reservations, and scenario identity backfill |
| `0006_workshop_registry.sql` | organization registry tokens and asynchronous immutable publications |
| `0007_workshop_runtime_delivery.sql` | app-route tracking, allocation locks, runtime access keys, and generic actual state |
| `0008_workshop_publication_claim_lease.sql` | reclaimable builder claim leases |
| `0009_scenario_runtime_data_backfill.sql` | remaining scenario VM/key/artifact/terminal/reservation backfill |
| `0010_runtime_artifact_ingestion.sql` | generic multipart artifact uploads and monotonic VM archive sealing |
| `0011_workshop_roster_runtime_guard.sql` | database-enforced roster immutability after workspace provisioning begins |
| `0012_workshop_agenda_focus.sql` | canonical agenda focus for briefing, lab, break, tinker, and retro timers |
| `0013_workshop_presence.sql` | durable roster heartbeat timestamps for server-derived present, stale, and absent state |
| `0014_workshop_live_membership_guards.sql` | route-issuance ledger plus fail-closed roster, workspace, generation, help, and assistance identity guards during membership removal |
| `0015_legacy_scenario_runtime_backfill.sql` | deterministic pre-V6 scenario VM, key, artifact, terminal, upload, seal, and reservation repair |

All twelve migrations are forward-only. `0005` also installs synchronization and
conflict triggers, so selectively removing tables is not a rollback.

Pre-V6 scenario state stores CPU allocation as
`provisioning.resources.vcpus`; newer state stores `cpuMillis`. Migration
`0009` required the newer field and therefore could not reconstruct those
older VMs. Migration `0015` applies the same deterministic conversion used by
the V6 cutover, `cpu_millis = vcpus * 1000`, and then idempotently replays the
dependent access keys, artifacts, eligible terminal sessions, multipart
uploads, completed-VM seals, and reservations. Because `0009` is already
ledgered, this correction must remain a new forward migration deployed by the
GitHub Actions workflow; do not edit historical D1 rows or run repair SQL from
an operator workstation. Keep starts frozen until `0015` is ledgered and every
mismatch check below returns zero.

## 6. Prove the migration and scenario compatibility

Verify the ledger and foreign keys first:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT id, name, applied_at FROM d1_migrations WHERE name IN ('0004_workshops.sql','0005_runtime_executions.sql','0006_workshop_registry.sql','0007_workshop_runtime_delivery.sql','0008_workshop_publication_claim_lease.sql','0009_scenario_runtime_data_backfill.sql','0010_runtime_artifact_ingestion.sql','0011_workshop_roster_runtime_guard.sql','0012_workshop_agenda_focus.sql','0013_workshop_presence.sql','0014_workshop_live_membership_guards.sql','0015_legacy_scenario_runtime_backfill.sql') ORDER BY id;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'PRAGMA foreign_key_check;'
```

The ledger must contain each filename exactly once, and
`PRAGMA foreign_key_check` must return no rows. Then run the mismatch checks;
every result must be zero:

```sh
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS execution_identity_mismatches FROM scenario_runs s LEFT JOIN runtime_executions e ON e.id = s.runtime_execution_id WHERE s.runtime_execution_id IS NULL OR e.id IS NULL OR e.domain_kind <> 'scenario' OR e.domain_id <> s.run_id OR e.generation <> 1 OR e.user_id <> s.user_id;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "WITH expected AS (SELECT s.run_id, coalesce(json_array_length(s.state_json, '$.vms'), 0) AS vm_count FROM scenario_runs s), actual AS (SELECT e.domain_id AS run_id, count(v.id) AS vm_count FROM runtime_executions e LEFT JOIN runtime_vms v ON v.execution_id = e.id WHERE e.domain_kind = 'scenario' GROUP BY e.domain_id) SELECT count(*) AS vm_backfill_mismatches FROM expected LEFT JOIN actual USING (run_id) WHERE expected.vm_count <> coalesce(actual.vm_count, 0);"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "WITH expected AS (SELECT s.runtime_execution_id AS execution_id, json_extract(vm.value, '$.id') AS vm_id, cast(json_extract(vm.value, '$.ordinal') AS integer) AS ordinal, json_extract(vm.value, '$.runtimeVmName') AS runtime_vm_name, CASE WHEN cast(json_extract(vm.value, '$.provisioning.resources.cpuMillis') AS integer) > 0 THEN cast(json_extract(vm.value, '$.provisioning.resources.cpuMillis') AS integer) WHEN cast(json_extract(vm.value, '$.provisioning.resources.vcpuCount') AS integer) > 0 THEN cast(json_extract(vm.value, '$.provisioning.resources.vcpuCount') AS integer) * 1000 WHEN cast(json_extract(vm.value, '$.provisioning.resources.vcpus') AS integer) > 0 THEN cast(json_extract(vm.value, '$.provisioning.resources.vcpus') AS integer) * 1000 ELSE NULL END AS cpu_millis, cast(json_extract(vm.value, '$.provisioning.resources.memoryMib') AS integer) AS memory_mib, cast(json_extract(vm.value, '$.provisioning.resources.diskMib') AS integer) AS disk_mib FROM scenario_runs s JOIN json_each(s.state_json, '$.vms') vm) SELECT count(*) AS vm_spec_mismatches FROM expected LEFT JOIN runtime_vms actual ON actual.execution_id = expected.execution_id AND actual.vm_id = expected.vm_id WHERE actual.id IS NULL OR actual.ordinal IS NOT expected.ordinal OR actual.runtime_vm_name IS NOT expected.runtime_vm_name OR actual.cpu_millis IS NOT expected.cpu_millis OR actual.memory_mib IS NOT expected.memory_mib OR actual.disk_mib IS NOT expected.disk_mib;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT count(*) AS access_key_mismatches FROM scenario_run_ssh_keys k JOIN scenario_runs s ON s.run_id = k.run_id LEFT JOIN runtime_vms v ON v.execution_id = s.runtime_execution_id AND v.vm_id = k.vm_id LEFT JOIN runtime_vm_access_keys a ON a.runtime_vm_id = v.id AND a.execution_id = s.runtime_execution_id WHERE a.runtime_vm_id IS NULL;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT count(*) AS artifact_mismatches FROM scenario_run_artifacts a JOIN scenario_runs s ON s.run_id = a.run_id LEFT JOIN runtime_artifacts r ON r.id = a.id AND r.execution_id = s.runtime_execution_id WHERE r.id IS NULL;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  'SELECT count(*) AS artifact_upload_mismatches FROM scenario_run_artifact_uploads legacy LEFT JOIN runtime_artifacts artifact ON artifact.id = legacy.artifact_id LEFT JOIN runtime_artifact_uploads runtime ON runtime.artifact_id = legacy.artifact_id WHERE artifact.id IS NULL OR runtime.artifact_id IS NULL OR runtime.r2_upload_id IS NOT legacy.r2_upload_id OR runtime.uploaded_parts_json <> legacy.uploaded_parts_json OR runtime.next_expected_part <> legacy.next_expected_part OR runtime.updated_at <> legacy.updated_at;'

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS invalid_runtime_artifact_rows FROM runtime_artifacts WHERE upload_status NOT IN ('pending','uploaded') OR (upload_status = 'uploaded' AND uploaded_at IS NULL) OR (upload_status = 'pending' AND uploaded_at IS NOT NULL); SELECT count(*) AS invalid_runtime_artifact_upload_rows FROM runtime_artifact_uploads WHERE next_expected_part <= 0 OR NOT json_valid(uploaded_parts_json);"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "WITH expected AS (SELECT s.runtime_execution_id AS execution_id, runtime_vm.id AS runtime_vm_id, cast(json_extract(session.value, '$.index') AS integer) AS ordinal, cast(json_extract(session.value, '$.startTimestampMs') AS integer) AS started_at, cast(json_extract(session.value, '$.startTimestampMs') AS integer) + cast(json_extract(session.value, '$.durationMs') AS integer) AS ended_at, cast(json_extract(session.value, '$.exitCode') AS integer) AS exit_code, artifact.id AS recording_artifact_id FROM scenario_runs s JOIN json_each(s.state_json, '$.vms') vm JOIN json_each(vm.value, '$.sessionTimeline') session LEFT JOIN runtime_vms runtime_vm ON runtime_vm.execution_id = s.runtime_execution_id AND runtime_vm.vm_id = json_extract(vm.value, '$.id') LEFT JOIN runtime_artifacts artifact ON artifact.execution_id = s.runtime_execution_id AND artifact.id = json_extract(session.value, '$.castArtifactId') WHERE json_type(session.value, '$.index') = 'integer' AND cast(json_extract(session.value, '$.startTimestampMs') AS integer) >= 0 AND cast(json_extract(session.value, '$.durationMs') AS integer) >= 0) SELECT count(*) AS terminal_session_mismatches FROM expected LEFT JOIN runtime_terminal_sessions actual ON actual.execution_id = expected.execution_id AND actual.runtime_vm_id = expected.runtime_vm_id AND actual.ordinal = expected.ordinal WHERE expected.runtime_vm_id IS NULL OR actual.id IS NULL OR actual.started_at IS NOT expected.started_at OR actual.ended_at IS NOT expected.ended_at OR actual.exit_code IS NOT expected.exit_code OR actual.recording_artifact_id IS NOT expected.recording_artifact_id;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS active_slot_mismatches FROM scenario_runs s LEFT JOIN active_runtime_slots slot ON slot.user_id = s.user_id AND slot.execution_id = s.runtime_execution_id WHERE s.active_key IS NOT NULL AND slot.user_id IS NULL; SELECT count(*) AS unexpected_slots_after_drain FROM active_runtime_slots; SELECT count(*) AS unreleased_reservations_after_drain FROM host_resource_reservations WHERE state IN ('pending', 'committed');"
```

Migrations `0009` and `0015` reconstruct historical terminal-session metadata
from each scenario VM's timeline. They intentionally do not copy plaintext
bodies from `scenario_run_session_transcripts` into
`runtime_terminal_sessions.transcript_r2_key`; existing scenario history keeps
using the legacy transcript table until a separate encrypted/R2 transcript
migration is designed. A zero terminal-session mismatch therefore proves the
session timeline, not generic transcript-object coverage.

If the deployment failed after migrations but before Worker deployment, keep
all starts frozen and rerun the same **Website production** workflow for the
same SHA. Applied migrations are ledgered and will not be reapplied. Do not
restore the database merely because the Worker step failed.

Next re-enable one drained platform scenario and one organization runner,
perform a complete scenario run, and prove:

- catalog, course assignment, briefing, hints, solution reveal, terminal,
  probes, artifacts, and teardown behave as before;
- `scenario_runs.runtime_execution_id` points to a generic execution;
- the user owns exactly one `active_runtime_slots` row while active;
- teardown removes that slot, releases the reservation, revokes the terminal
  route, and leaves the archived scenario history readable.

Only after that regression passes, restore the recorded scenario enablement
set and re-enable the remaining organization runners. Keep
`workshops_enabled` unmatched.

## 7. Roll out Stargate drain-first

The new binary adds SQLite migrations `0002_workspace_app_routes.sql` and
`0003_workspace_app_browser_sessions.sql`, plus HTTP and WebSocket reverse
proxying over the existing SSH direct-forward channel. No guest or host
application port is made public.

### 7.1 Build and identify the release

From `main`, dispatch `.github/workflows/release.yml` with:

- `project`: `stargate`;
- `bump`: the approved semantic version increment.

The **Release** workflow runs `just verify`, produces GitHub release assets plus
`stargate_<version>_linux_{amd64,arm64}.tar.gz` and a checksum file, writes a
release version commit, and atomically pushes it with the
`stargate/v<version>` tag.
Because that commit changes `Cargo.lock`, it also triggers **Website
production**. Keep starts drained and watch that additional deployment before
continuing.

Download the artifact matching the host, verify it against
`stargate_<version>_checksums.txt`, and record both release tag and SHA-256.

### 7.2 Reconcile the first-level wildcard edge

The desired edge state is checked in at
`ops/cloudflare/workshop-app-routing.json` and is applied only by
`.github/workflows/workshop-app-edge.yml`. It owns exactly these resources:

- one proxied `*.intar.app` CNAME to
  `8cdc5d07-3703-4508-9dc6-3dc861dd560b.cfargotunnel.com`, with automatic TTL;
- the `*.intar.app` rule inserted between the existing exact `ws.intar.app`
  rule and final `http_status:404` rule on that remotely managed Tunnel;
- one final `http_request_cache_settings` rule, identified by the stable ref
  `intar_workshop_app_hosts_bypass_cache_v1`, that sets `cache = false` for
  `wa-*.intar.app`.

The reconciler uses Cloudflare's current [DNS Records API][dns-records-api],
[remotely managed Tunnel configuration API][tunnel-configuration-api], and
rule-level [Cache Rules API][cache-rules-api]. It never replaces a complete
Cache Rules ruleset.

Exact DNS records such as `ws.intar.app`, `ssh.intar.app`, and
`admin.intar.app` take precedence over the wildcard and remain untouched. The
reconciler also preserves unrelated Cache Rules and their order. It accepts
only the exact Tunnel baseline `[ws, 404]` or desired
`[ws, wildcard, 404]`; an unknown ingress, duplicate managed cache identity,
changed managed rule, or conflicting wildcard DNS record aborts the run.

Create the production environment secrets before dispatching the workflow:

- `CLOUDFLARE_ACCOUNT_ID` for the account that owns the Tunnel;
- `CLOUDFLARE_INTAR_APP_ZONE_ID` for the `intar.app` zone;
- `CLOUDFLARE_WORKSHOP_EDGE_API_TOKEN`, a dedicated token restricted to that
  account and zone. Grant account **Cloudflare One Connector: cloudflared
  Edit**, zone **DNS Edit**, and zone **Cache Rules Edit**. Cloudflare's current
  Cache Rules API also documents account **Account Rulesets Edit** and
  **Account Filter Lists Edit** as required; include them only on this dedicated
  token and do not reuse the website deployment token.

Prefer protecting the GitHub `production` environment with a required
reviewer and prevent-self-review. During initial commissioning by a repository
with exactly one administrator and no other collaborators, the documented
single-operator exception may be used instead. In both modes, restrict
deployment branches to `main`. The workflow also checks `refs/heads/main`
before checkout and the reconciler independently rejects an apply or rollback
outside a manually dispatched main-branch run.

From `main`, dispatch **Workshop application edge** with `operation=plan`.
In `single-operator` mode, also supply
`single_operator_confirmation=SINGLE OPERATOR WORKSHOP EDGE`. Review the
redacted inventory and require only the three expected changes. Then dispatch
`operation=apply` with `confirmation=APPLY WORKSHOP EDGE` and, in
single-operator mode, the same single-operator confirmation. In `reviewed`
mode, approve the `production` environment. The workflow serializes runs,
verifies the checked-out commit and approval guard, rejects mutations from any
branch other than `main`, applies the cache rule and Tunnel before creating
DNS, and re-reads all three resources before succeeding. It never prints the
API token. A rollback requires `confirmation=ROLLBACK WORKSHOP EDGE` and the
single-operator confirmation when that mode is active.

Prove the existing exact hostname and the new edge path before issuing a real
route:

```sh
curl --fail-with-body --silent --show-error https://ws.intar.app/healthz
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://wa-no-such-route.intar.app/
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://garbage.intar.app/
```

Before the new Stargate binary starts, the two wildcard probes may both return
`404`; they must not fail DNS, TLS, Tunnel, or origin connection. After the new
binary starts, the canonical `wa-` hostname must return `401` and the arbitrary
hostname must return `404`. A proxied static response under a real app route
must report `CF-Cache-Status: DYNAMIC`.

### 7.3 Replace the service

The production binary is replaced only by
`.github/workflows/stargate-deploy.yml`. The workflow is main-only, serialized,
uses the protected `production` environment, verifies the GitHub release
archive and extracted binary, and delegates the host mutation to the root-owned
`ops/stargate/intar-deploy-stargate` command. Do not copy a binary into
production from a workstation.

Bootstrap its restricted host identity once through the existing root
management channel or provider console:

1. create a dedicated ED25519 key with the exact comment
   `intar-stargate-production-ci` and no access to any other host;
2. transfer only its public key, `ops/stargate/bootstrap-deploy-user`, and
   `ops/stargate/intar-deploy-stargate` to a root-only temporary directory;
3. run `bootstrap-deploy-user PUBLIC_KEY_FILE DEPLOY_COMMAND_FILE` as root;
4. delete the transferred temporary files and retain the private key only as
   the GitHub environment secret described below.

The bootstrap creates a locked `stargate-deploy` service account, a restricted
`authorized_keys` entry, the root-owned deployment command, and a narrow
passwordless sudo rule for that command. It does not grant a general root
shell. Run the bootstrap again to rotate the key or update the host command.

Configure these `production` environment values:

- variable `STARGATE_DEPLOY_HOST=intar.app`;
- variable `STARGATE_DEPLOY_PORT=2222`;
- variable `STARGATE_DEPLOY_USER=stargate-deploy`;
- variable `STARGATE_DEPLOY_APPROVAL_MODE`, set to `reviewed` when an
  independent approver exists or `single-operator` only while the repository
  has exactly one collaborator and that collaborator is an administrator;
- variable `STARGATE_SINGLE_OPERATOR_LOGIN`, set to the sole administrator's
  GitHub login only while `STARGATE_DEPLOY_APPROVAL_MODE=single-operator`;
- secret `STARGATE_DEPLOY_SSH_PRIVATE_KEY`, containing only the dedicated
  private key;
- secret `STARGATE_DEPLOY_KNOWN_HOSTS`, containing the pinned
  `[intar.app]:2222` ED25519 host-key line verified through an independent
  channel.

Always allow deployments from the `main` branch only. In `reviewed` mode,
require at least one independent reviewer and enable prevent-self-review. In
`single-operator` mode, keep the reviewer rule absent: the workflow lists all
repository collaborators and proceeds only when the actor is the sole
administrator and also the original triggering actor. Adding any collaborator
therefore fails closed until the approval mode and protection are deliberately
reconciled.

Dispatch **Stargate production** from `main` with `operation=plan`. Its host
output must show an active service and zero terminal routes, workspace
application routes, and browser sessions. In `single-operator` mode, include
`single_operator_confirmation=SINGLE OPERATOR STARGATE` on this and every
other dispatch. For the cutover, dispatch it again with:

- `operation=apply`;
- the exact approved `stargate/v<version>` release tag;
- `confirmation=DEPLOY STARGATE`;
- in `single-operator` mode only,
  `single_operator_confirmation=SINGLE OPERATOR STARGATE`.

In `reviewed` mode, approve the protected environment only after comparing the
plan with the drain record. In `single-operator` mode, the sole operator makes
that comparison before entering the exact dispatch confirmation. The host
command validates the archive before mutation, makes an online SQLite backup
while the existing service remains healthy, checks the drain again after
stopping it, atomically installs the binary, and installs a systemd drop-in
equivalent to:

```toml
workspace_app_base_domain = "intar.app"
workspace_app_bootstrap_ttl_seconds = 60
workspace_app_session_ttl_seconds = 900
```

It then waits for readiness, verifies migrations `2` and `3`, exercises the
host-first `200/401/404` routing contract, and prints the named backup ID. A
failed host transaction automatically restores the prior binary,
configuration, and drop-in; a failed public routing verification triggers a
rollback to that same backup before the workflow ends in failure. The additive
SQLite migrations remain in place. The workflow finally requires:

- `https://ws.intar.app/healthz` to succeed;
- `https://wa-no-such-route.intar.app/` to return `401`;
- `https://garbage.intar.app/` to return `404`;
- the final host plan to remain readable through the pinned deployment key.

To restore an earlier release, dispatch the same workflow with
`operation=rollback`, the exact backup ID, and
`confirmation=ROLLBACK STARGATE`. In `single-operator` mode, also supply the
same single-operator confirmation. Rollback makes a second safety backup
before stopping the service and restores that safety backup automatically if
the requested rollback fails.

After the CI cutover, run the existing browser-terminal scenario smoke once
starts are re-enabled; the `ws.intar.app` terminal path must remain unchanged.
Issue one real workshop application route and prove its bootstrap URL returns
a `303` with `Cache-Control: no-store`, removes `__intar_bootstrap` from the
location, and sets an `HttpOnly; Secure; SameSite=Lax` route-specific cookie.
Reusing the consumed bootstrap must return `401`; deleting the route must make
the cookie fail for both HTTP and WebSocket requests.

## 8. Publish and prewarm the canary revision

Only proceed after the concrete builder and dedicated guest image hard gates
are met.

### 8.1 Install the trusted workshop builder

Dispatch `.github/workflows/release.yml` from `main` with project
`intar-workshop-builder`, verify the resulting checksum, and install the amd64
archive on the dedicated Linux/KVM builder. The current concrete backend is
deliberately x86_64 and one-VM-only; the HCL/compiler and learner runtime retain
multi-VM data, but publication must fail before claiming work if a template
contains more than one VM. Do not silently collapse such a template.

Install the archive's binary, service, sanitizer, and example config; create a
non-login `intar-builder` user with KVM access; and keep the mapped base disk,
kernel, and initrd root-owned and read-only to that user. Configure the exact
`workspace.vm.image` mapping and enumerate every guest-only solve path in
`guest_build_material_paths`. Repeat those paths in
`guest_forbidden_participant_paths`, together with `.git`, every lab `solve.sh`
and source README, facilitator slides, and the known backup/duplicate roots from
the example config. Cold-boot proof must reject any listed path. The participant
repository must have no unlisted backup copy or answer-key path either.

Before starting the service, require:

```sh
sudo -u intar-builder /usr/local/bin/intar-workshop-builder doctor \
  --config /etc/intar/workshop-builder.toml
sudo systemctl enable --now intar-workshop-builder.service
sudo systemctl is-active intar-workshop-builder.service
sudo journalctl --unit intar-workshop-builder.service --since '-10 minutes' --no-pager
```

For the first canary, keep the daemon stopped and use `run-once` so one operator
can retain the complete QEMU, QMP, SSH, sanitizer, upload, and cold-boot log.
Only enable continuous `run` after that publication passes every guest/image
gate. The full backend and participant-image boundary are documented in
`crates/intar-workshop-builder/README.md`.

The installed unit sends SIGTERM and allows three minutes for cooperative
cleanup before systemd applies its cgroup kill fallback. SIGINT and SIGTERM
both cancel the current worker, kill and reap QEMU, and leave an interrupted
registry claim resumable rather than reporting a terminal publication
failure. On the next start, the builder removes only direct `publication-*`
children carrying its exact staging marker from the two preflighted private
work roots; never replace this with a recursive cleanup of a configured root.
Exercise one stop during the canary and require both the “cancelling active
work” and “cleaned active state” journal entries before restarting it.

### 8.2 Publish the canary revision

Enable the exact `workshops_enabled` rule for the internal canary
organization, then create a short-lived organization-scoped registry token.
The token is returned once:

```sh
umask 077
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "cookie: <CANARY_ORG_ADMIN_COOKIE>" \
  --header 'content-type: application/json' \
  --data '{"name":"platform-workshop-canary"}' \
  'https://intar.dev/api/organizations/<CANARY_ORG_ID>/workshops/tokens' \
  > /tmp/intar-workshop-token.json
```

Load the returned `token` into `INTAR_WORKSHOP_PUBLISH_TOKEN` without echoing
it, set `INTAR_WORKSHOP_REGISTRY_URL=https://intar.dev`, and publish:

```sh
cargo run -p intar-workshop-cli -- publish workshops/platform-engineering
cargo run -p intar-workshop-cli -- status <PUBLICATION_ID>
```

Do not interpret upload acceptance or `building` as publication. Wait for
`published`, then verify D1:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT id, organization_id, workshop_slug, content_hash, status, builder_host_id, published_revision_id, error FROM workshop_publications WHERE id = '<PUBLICATION_ID>';"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT checkpoint_id, status, sanitized, cold_boot_verified, error FROM workshop_publication_checkpoints WHERE publication_id = '<PUBLICATION_ID>' ORDER BY checkpoint_id;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT r.id, r.revision, json_extract(r.manifest_json, '$.durationMinutes') AS minutes, json_array_length(r.manifest_json, '$.modules') AS modules, json_array_length(r.manifest_json, '$.presentation.slides') AS slides, json_extract(r.manifest_json, '$.workshop.attribution.license') AS license FROM workshop_template_revisions r WHERE r.id = '<REVISION_ID>';"
```

Require 11 verified checkpoints, every `sanitized` and
`cold_boot_verified` value equal to `1`, 240 minutes, 11 modules, 85 slides,
and Apache-2.0 attribution.

Successful publication requests cache prewarm for every non-disabled agent in
the same organization. Keep canary runners enabled, connected, and idle. Wait
until each recovery-eligible runner's reported `cached_images` contains every
checkpoint image at phase `ready` with the exact image key and SHA-256 from the
immutable revision. The lobby capacity gate must show:

- `imagesReady = true`;
- at least two healthy runners;
- `seatsAvailable >= checked-in participants + 1`;
- no missing image, CPU, memory, or worst-case disk allocation failure.

Do not bulk-provision while any required image is `pending`, `pulling`,
`failed`, absent, or hash-mismatched. Runtime workshop traffic must remain
functional with conference Internet access blocked.

## 9. Canary live E2E

Create a session from the published revision in
`/organizations/<CANARY_ORG_ID>/workshops`. Roster exactly:

- one facilitator;
- one helper;
- at least two participants.

Set the start far enough in the future for the 30-minute lobby, then perform the
checks below. Record API statuses, relevant D1 rows, screenshots, and host logs.

### 9.1 Authorization and immutable identity

- A member of another organization cannot list the canary template, load the
  session, fetch a slide asset, or infer names from error bodies.
- An unrostered member of the canary organization cannot load the room,
  presenter, projector, terminal, app, help, or action endpoints.
- Remove a rostered learner from the organization while leaving the roster row
  intact. Every Intar workshop endpoint must stop working. Explicitly delete
  any issued application route and prove its browser cookie and active tunnel
  stop immediately. Pause one create while its issuance intent is pending:
  removal must clean known routes and runtimes but leave the membership fenced;
  after the create resolves, a retry must delete its deterministic route and
  finish removal. Also prove that a create cancelled at the 30-second request
  deadline cannot first become effective after the two-minute recovery lease.
  Sign-out without explicit route deletion remains bounded by the configured
  15-minute Stargate route/session expiry.
- The facilitator can load `/present`; participants and helpers cannot gain
  facilitator controls by calling the action endpoint directly.
- The projector shows slide, outcome, and timer but no roster, learner name,
  email, help request, probe owner, or terminal history.
- Capture the session's `template_revision_id`. Publishing another revision
  must not change that value.

### 9.2 Lobby, capacity, and active-slot admission

1. Let the every-minute Cron Trigger open the lobby at the configured time.
   Module `00` is released and one automatic `session.lobby` event is recorded;
   a second tick is idempotent.
2. Check in both participants; do not provision the helper or facilitator.
   Keep one room visible and confirm its roster heartbeat advances
   `workshop_session_members.last_seen_at` independently of the two-second room
   projection poll. The facilitator view must report that learner `present`
   within 30 seconds, `stale` after 30 seconds without a heartbeat, and
   `absent` after two minutes, using the projection's server timestamp. A
   hidden or closed room must stop its 15-second client heartbeat.
3. Confirm capacity reserves aggregate CPU, memory, and disk without counting
   a pending seat twice.
4. Bulk-provision both checked-in participants from `checkpoint-00`.
5. If one allocation is intentionally made to fail, correct only that runner
   condition and retry; the already-ready workspace must not be replaced.
6. For each participant, wait for workspace, terminal target, named module-00
   probe, and all three runtime layers to report ready: session member,
   workspace generation, and `runtime_vm_actual_state`.
7. While one learner owns a workshop slot, attempt to start a scenario as that
   learner. Require the shared `runtime_active_slot_conflict`. A different
   learner without a workspace must still be able to start a scenario.
8. Race one scenario start and one workshop provision against capacity for
   only one remaining seat. Exactly one allocation may win; committed plus
   pending reservations must never exceed host CPU, memory, or disk capacity.
9. Have a pre-rostered late participant check in, then select a predecessor
   checkpoint. Force the first provisioning attempt to fail. No module becomes
   `caught_up` until the new generation is ready; after retry, skipped modules
   are `caught_up`, never `verified`.

Each participant must have one logical workspace and one current generation;
the two low-level execution IDs and SSH keypairs must be distinct.

### 9.3 Presentation and facilitator concurrency

- Exercise all 85 slides, presenter notes, keyboard navigation, projector
  synchronization, timer pause/resume, module focus, solution reveal, and
  reduced-motion mode.
- Verify released participant slides never include presenter notes or an
  unrevealed solution.
- Inspect the participant projection before a later slide is released. Its
  Markdown/body and asset paths must be absent, not merely tagged unreleased.
- Send two facilitator mutations with the same `version`. Exactly one must
  succeed; the other must return `409`, and the session version advances once.
- Keep one projector open while another facilitator changes slide/module; it
  must converge through the two-second poll using server timestamps.

### 9.4 Guest and probe proof

From both learner browser terminals:

- run the pinned module-00 verifier and prove no external image pull occurs;
- complete module 01 in at least one workspace and run
  `/opt/platform-engineering-workshop/lab/01-cluster/verify.sh`;
- attach `docker info`, Talos node state, `kubectl get nodes`, Cilium status,
  kube-proxy absence, and the verifier result;
- prove a privileged Docker workload succeeds inside the actual Intar guest;
- prove the dedicated kernel exposes the eBPF capabilities Cilium needs;
- prove the participant filesystem has manual `verify.sh` material but no
  canonical catch-up/solve script, solution bundle, or facilitator notes;
- complete the explain-back and confirm technical and explain-back states are
  independent;
- after verification latches, deliberately regress one named check. D1 must
  retain `technical_status = 'verified'` and `first_verified_at` while
  `current_health = 'failing'`. Repair it and require `current_health =
  'passing'` again.

Never accept the upstream kind fallback as Talos/Cilium proof.

### 9.5 Module release and all declared applications

Release core modules sequentially and stretch modules only after their declared
dependencies. Confirm a premature core or stretch release is rejected. Release
the application-bearing modules and open every declared app through its
learner-room action:

| Application | Guest port |
| --- | ---: |
| Gitea | 30300 |
| Argo CD | 30080 |
| RustFS | 30901 |
| Knative | 31081 |
| Zot | 30500 |
| Cloudbox Console | 30600 |
| Grafana | 30030 |

For every app require:

- a short-lived URL under `<route-id>.intar.app`;
- a membership and workspace-owner check before route creation;
- correct HTTP behavior, cookies, redirects, static assets, and any WebSocket
  upgrade used by the UI;
- the one-time bootstrap URL returns a `303`, scrubs the capability from the
  address, and cannot be replayed in a signed-out browser or by the other
  learner; subsequent HTTP and WebSocket requests require only the
  route-specific cookie until its bounded expiry or explicit route deletion;
- no direct public listener on the agent host for the guest app port;
- a `404` for an undeclared application ID and no endpoint for a
  learner-selected port or raw TCP route;
- helper and facilitator requests for a learner's app return a non-enumerable
  authorization failure.

### 9.6 Help consent and artifact ownership

1. Learner 1 submits a help request; the helper claims it.
2. Before learner consent, the helper's browser-terminal request for learner
   1's workspace must return `403` and create no Stargate route.
3. Learner 1 grants access. Verify a 15-minute maximum initial expiry, then the
   helper opens only a browser terminal.
4. Renew once and verify the absolute expiry is no later than 30 minutes after
   `granted_at`.
5. Revoke immediately. The existing browser connection must close, its route
   must disappear, and a new terminal request must return `403`.
6. Repeat with a second grant and allow it to expire naturally; prove the same
   behavior after expiry.
7. Resolve the claimed request through the deployed helper UI/API and verify
   its state and audit event.
8. Confirm `workshop_events` records the request, claim, grant, helper terminal
   open, renewal if audited, and revoke with the correct actor and grant/route
   IDs.
9. Facilitator and helper can see named probe pass/fail state but cannot fetch
   raw terminal recordings, transcripts, or runtime artifacts. Native SSH and
   workspace applications remain unavailable to the helper.
10. The participant can use native SSH with their own profile key; neither the
    helper grant nor a facilitator role authorizes native SSH.

### 9.7 Destructive checkpoint restore

In learner 1's workspace, create a marker after the current canonical
checkpoint and open at least one terminal and application route. Record the
current workspace ID, generation ordinal, execution ID, host ID, routes,
progress, and artifacts.

1. Submit `restore_checkpoint` without `confirmed: true`; require `400` and no
   generation change.
2. Confirm the warning and restore the selected canonical checkpoint.
3. Require a new generation and new low-level execution under the same logical
   workspace.
4. Require the old execution to archive, disappear from host desired state,
   and lose every terminal/application route. The marker must be gone.
5. Require module progress, explain-back, hint history, events, and the latched
   verification timestamp to remain.
6. Require new artifacts to reference only the new execution/runtime VM while
   old artifacts remain attached to the archived generation.
7. Replay a stale actual-state report from the old generation; it must not
   overwrite the current generation or terminal target.

### 9.8 Host-to-host recovery

Choose a learner workspace on runner A and record the latest applicable
canonical checkpoint. Ensure runner B is healthy, has that image ready, and has
one full free seat.

1. Stop `intar-agent` on runner A without deleting its state or stopping
   jailerd.
2. Let the production host-failure path detect the stale/disconnected host; do
   not call the recovery library directly from a console.
3. Require a new generation on a different runner, restoration from the latest
   applicable canonical checkpoint, and a learner-visible warning that work
   since that checkpoint may be lost.
4. Require old routes to be revoked before new routes are issued. Progress and
   append-only events remain unchanged.
5. Start runner A again. Its stale generation report must be rejected, and the
   converged desired state must remove the abandoned VM.
6. Verify the recovered terminal, named probes, and every currently released
   app route on runner B.

Abort the pilot if recovery selects the failed host, mutates the old disk in
place, loses logical progress, accepts a stale report, or leaves the old route
usable.

### 9.9 End and prove zero leaks

End the session through the facilitator action. Do not flip the flag or restore
D1 while teardown is running. Wait for host desired and actual state to
converge, then run these read-only D1 checks with the exact session ID:

```sh
cd website
bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT state, count(*) FROM workshop_workspaces WHERE session_id = '<SESSION_ID>' GROUP BY state; SELECT state, count(*) FROM workshop_workspace_generations WHERE workspace_id IN (SELECT id FROM workshop_workspaces WHERE session_id = '<SESSION_ID>') GROUP BY state;"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS live_executions FROM runtime_executions WHERE domain_kind = 'workshop' AND domain_id IN (SELECT id FROM workshop_workspaces WHERE session_id = '<SESSION_ID>') AND state NOT IN ('archived','failed'); SELECT count(*) AS active_slots FROM active_runtime_slots WHERE execution_id IN (SELECT runtime_execution_id FROM workshop_workspace_generations WHERE workspace_id IN (SELECT id FROM workshop_workspaces WHERE session_id = '<SESSION_ID>')); SELECT count(*) AS live_reservations FROM host_resource_reservations WHERE execution_id IN (SELECT runtime_execution_id FROM workshop_workspace_generations WHERE workspace_id IN (SELECT id FROM workshop_workspaces WHERE session_id = '<SESSION_ID>')) AND state <> 'released';"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT count(*) AS stored_terminal_routes FROM workshop_workspaces w, json_each(w.terminal_route_usernames_json) WHERE w.session_id = '<SESSION_ID>'; SELECT count(*) AS stored_app_routes FROM workshop_workspaces w, json_each(w.application_route_ids_json) WHERE w.session_id = '<SESSION_ID>'; SELECT count(*) AS active_assists FROM workshop_assist_grants WHERE session_id = '<SESSION_ID>' AND revoked_at IS NULL AND expires_at > cast(unixepoch('subsecond') * 1000 AS integer); SELECT count(*) AS open_help FROM workshop_help_requests WHERE session_id = '<SESSION_ID>' AND status IN ('open','claimed');"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT h.host_id, json_extract(vm.value, '$.run_id') AS execution_id, json_extract(vm.value, '$.vm_name') AS vm_name, json_extract(vm.value, '$.desired_phase') AS desired_phase FROM host_desired_state h, json_each(h.doc_json, '$.vms') vm WHERE json_extract(vm.value, '$.run_id') IN (SELECT runtime_execution_id FROM workshop_workspace_generations WHERE workspace_id IN (SELECT id FROM workshop_workspaces WHERE session_id = '<SESSION_ID>')) AND json_extract(vm.value, '$.desired_phase') <> 'absent';"

bunx wrangler d1 execute DB --remote --config wrangler.jsonc --command \
  "SELECT h.host_id, json_extract(vm.value, '$.run_id') AS execution_id, json_extract(vm.value, '$.vm_name') AS vm_name, json_extract(vm.value, '$.phase') AS phase FROM host_actual_state h, json_each(h.report_json, '$.vms') vm WHERE json_extract(vm.value, '$.run_id') IN (SELECT runtime_execution_id FROM workshop_workspace_generations WHERE workspace_id IN (SELECT id FROM workshop_workspaces WHERE session_id = '<SESSION_ID>')) AND json_extract(vm.value, '$.phase') NOT IN ('absent', 'stopped');"
```

Expected results:

- session `ended`;
- all workspaces `ended` and all generations `archived` (a genuinely failed
  generation may remain `failed` with its error preserved);
- zero live executions, active slots, unreleased reservations, stored routes,
  active assists, open help requests, non-absent desired VMs, and nonterminal
  actual VMs. Retained `absent`/`stopped` tombstones are audit state, not leaks.

On the Stargate host, query with the exact execution IDs recorded for this
session:

```sh
sudo -u stargate sqlite3 /var/lib/stargate/routes.sqlite3 \
  "SELECT route_username, run_id, user_id, expires_at FROM routes WHERE run_id IN ('<EXECUTION_ID_1>','<EXECUTION_ID_2>');"
sudo -u stargate sqlite3 /var/lib/stargate/routes.sqlite3 \
  "SELECT route_id, run_id, user_id, target_app_port, expires_at FROM workspace_app_routes WHERE run_id IN ('<EXECUTION_ID_1>','<EXECUTION_ID_2>');"
```

Both queries must return no rows. Also require no pilot VM unit, jail,
namespace, TAP, nftables rule, SSH DNAT, recording upload, or cache lease remains
on any runner. Archived recordings and artifacts in R2 are expected; a live
route or VM is not.

## 10. Accept the canary and enable the human pilot

Attach the full evidence set and have a second operator review it. Then:

1. keep the canary session archived;
2. add one exact Flagship rule for the human pilot organization ID, still with
   default `false` and no percentage rollout;
3. create a publisher token scoped to that organization;
4. publish the same validated source and wait for its own immutable revision;
5. wait for every pilot runner to prewarm all checkpoints;
6. schedule the real session with an explicit organization-member roster;
7. revoke the one-time publisher token when publication is complete.

Do not copy a template/revision row between organizations. The registry token,
publication, template, revision, session, runner selection, and roster must all
resolve to the same organization.

## Abort and rollback boundaries

### Before `0004`–`0015`

Re-enable only the scenarios and runners recorded before the drain. Remove any
unapplied canary flag rule. No database rollback is needed.

### Migrations applied, new Worker not healthy

Keep starts frozen and the workshop flag unmatched. Rerun **Website
production** for the same commit. The migrations are additive and ledgered;
the previous Worker can remain during a forward repair. If a code rollback is
required, merge a revert and let the same GitHub Actions workflow deploy it;
leave the new schema in place.

Use the recorded D1 Time Travel bookmark only for proven database corruption
or destructive data loss, after stopping all scenario/workshop writes and
obtaining explicit incident approval. A Time Travel restore overwrites D1 and
cancels in-flight queries. It can orphan host VMs, Stargate routes, and R2
artifacts created after the bookmark, so reconcile those external resources
before reopening starts.

### Stargate failure

Keep the workshop flag unmatched and disable route issuance. Drain all routes,
then dispatch **Stargate production** from `main` with `operation=rollback`, the
recorded backup ID, and `confirmation=ROLLBACK STARGATE`. Approve the protected
`production` environment, record the new rollback safety backup ID, and prove
`ws.intar.app` terminal health. Do not manually replace the binary or TOML.
The additive `workspace_app_routes` and `workspace_app_browser_sessions` tables
may remain.

Remove wildcard DNS/ingress only after confirming no workspace-app route
exists. Dispatch **Workshop application edge** from `main` with
`operation=rollback` and approve the `production` environment; it removes only
the owned wildcard CNAME and managed cache rule, restores the exact `[ws, 404]`
Tunnel baseline, and verifies that state. Do not manually replace the whole
Cache Rules ruleset.

### Publication or prewarm failure

Do not create a session. A `failed` publication and its checkpoint errors are
evidence; do not rewrite it to `queued` or `published`. Fix the builder/image,
publish a new source bundle, and wait for a new successful immutable revision.
Remove the canary organization's flag rule while the failure is investigated.

### Live pilot failure

Stop releasing modules, announce the pause, and end or cancel the session
through the facilitator action. Do not delete D1 rows or host state. If normal
teardown fails, keep all related runners out of scheduling, retain desired and
actual reports, revoke routes through the authenticated control-plane path,
and reconcile until the zero-leak checks pass. Disable the organization flag
only after teardown has been requested; the flag is not a teardown mechanism.

No additional organization may be enabled until the incident is understood,
a forward fix has passed the same canary, and Courses/Scenarios regression
evidence remains green.

[d1-time-travel]: https://developers.cloudflare.com/d1/reference/time-travel/
[dns-records-api]: https://developers.cloudflare.com/api/resources/dns/subresources/records/
[tunnel-configuration-api]: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/
[cache-rules-api]: https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/
[universal-ssl]: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/
