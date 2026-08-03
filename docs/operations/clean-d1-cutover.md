# Clean D1 cutover

This is a destructive application cutover, not a database migration. The new
web artifact and new D1 database are one compatibility unit. The old web
artifact and old D1 database are the rollback unit.

## Safety rules

- Perform production mutation only in the protected GitHub Actions workflow.
- Never point old code at the new database or new code at the old database.
- Keep the old database read-only during the rollback window.
- Disable new Workshop issuance before rollback; continue reconciliation and
  cleanup until every external resource is absent.
- Do not delete either provider credential KEK while a credential version or
  cleanup-pending allocation may still require it.
- Deleting the old D1 database and old Worker identities is a later, explicitly
  confirmed operation.

Use `.github/workflows/clean-d1-cutover.yml`. `plan` is read-only and retains a
baseline digest plus D1 inventory. `apply` creates the explicitly named database
when absent, applies only `migrations/0000_clean_multicloud.sql`, and atomically
writes a provenance-bound commissioning receipt plus the one GitHub allowlist
identity verified against the protected workflow actor. Before creating or
writing the new database, it queries the selected old database read-only and
requires every runtime, allocation, terminal, assistance, route, allocation
lock, and nonterminal Workshop count to be zero. After that identity completes
its first OAuth login, `bootstrap-owner` promotes only that sole matching user
and GitHub account while the database still has zero organizations and members.
`apply` first proves that the active `intar-dev` version has exactly one `DB`
binding and that it is the selected old database. It requires all Scenario,
Workshop, build, publication, provider, terminal, route-intent, reservation,
artifact-upload, and open cost-ledger counts to be zero. It also calls the
legacy route-less Hetzner provider with the encrypted credential already stored
in old D1, requiring a real, current project inventory with no sentinel or
other resources and a disconnected connection. Enabled runner and builder
reports must be fresh, caught up to their desired-state version, and contain no
VMs or builds; no non-absent runtime VM actual state may remain. Each drain pass
also uses the pinned restricted Stargate deployment identity to execute its
read-only `plan` command. The exact ten-line protocol must report an active
service, zero terminal routes, application routes, and browser sessions, the
`intar.app` base domain, 60/900 second TTLs, and ready application migrations.
D1 state is never accepted as a substitute for provider or Stargate inventory.

The single baseline is larger than [D1's per-query SQL
limit](https://developers.cloudflare.com/d1/platform/limits/). CI therefore
does not submit it through `d1 migrations apply`, which sends a complete
migration as one remote query. It deterministically wraps the exact baseline
with Wrangler's migration table and one ledger row, then uses D1's [atomic
file-import path](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
Local validation and production use the same generated import, and CI rechecks
its digest immediately before upload. A failed import leaves the database at
its pre-import state and may resume only from an absent or empty migration
ledger.

After that initial proof, CI uploads a tiny maintenance version under the
existing `intar-dev` identity and exact old D1 binding without activating it.
It proves the current deployment is unchanged, then promotes only the captured
version UUID to 100 percent traffic. Because the deployment API can become
canonical before the new version reaches the runner's edge location, CI waits
boundedly for the exact public marker and `503` behavior before continuing.
This version-only flow does not reconcile
the existing custom domain, cron trigger, or Durable Object lifecycle. The
exact marker endpoint is the only successful HTTP route; all other traffic
receives a no-store `503`. CI waits for old requests to quiesce and proves the
complete D1, Hetzner, host, and Stargate drain twice more.

If a later step fails and leaves that fence active, a fresh first-attempt
dispatch at the exact same `main` SHA validates the marker, origin workflow,
version tag, previous version, and old D1 binding. It then restores exactly the
recorded previous version at 100 percent traffic before rerunning the unchanged
strict initial drain. Recovery likewise waits boundedly until the public fence
header disappears and the normal root page is healthy. Only stale runner or
builder reports may be retried while
they reconnect; every other drain failure remains immediately blocking. CI
retains structured Wrangler upload/deploy output and recovery attempts even
when a later proof fails. The web deployment verifies the successful apply
artifact and active maintenance version, repeats the full drain twice
immediately before replacing it, and then proves the deployed version has
exactly the clean `DB` binding.

`rollback` requires issuance to be disabled, verifies exactly one `DB` binding
on the selected previous Worker version, and deploys that exact existing version
at 100 percent traffic. It then queries the deployment and version again, waits
boundedly for the public fence to disappear and the root page to recover, and
retains the structured deployment and propagation proof. This version-only
operation does not mutate routes, crons, the D1 databases, or Durable Object
lifecycle. Finding the old UUID in an unrelated variable or binding is not
sufficient. It never deletes the new database.

Every mutating operation uses the same reviewed or time-bounded single-operator
production gate as the web deployment. It verifies the exact `main` SHA,
production branch policy, actor login and numeric GitHub ID, approval mode,
single-operator expiry, and fresh administrator attestation. `plan` validates
the exact `main` SHA but never accepts a mutation confirmation.

Before any remote inventory or mutation, the workflow runs
`bun run check:bootstrap` and `bun run check:clean-owner-bootstrap`. The first
creates a fresh in-memory database, applies the single baseline, and repeats a
deterministic owner, organization, Scenario, Course, and Workshop publication
bootstrap twice. The focused owner test proves canonical identity validation,
exact schema and all-table emptiness, resumable commissioning, GitHub account
binding, idempotent promotion, and the extra-user, account, organization, and
membership fences. Neither check contains provider credentials or can reach or
mutate production.

For `apply`, provide the dispatching owner's exact GitHub login and numeric
GitHub user ID, and the exact previous production D1 UUID. The workflow resolves
that identity through GitHub and requires it to match both the workflow actor
and the configured single operator when that mode is active. It compares the
complete new schema with the locally applied baseline and refuses to seed if any
application table contains data. The marker and allowlist are one remote-file
transaction. A later same-SHA dispatch may rebind the marker only when the prior
first-attempt run is completed with a failed or cancelled conclusion and the
database still contains exactly that marker and allowlist; orphan or unrelated
state fails closed. The seed contains no user or session; it only permits the
verified owner to complete OAuth after the web cutover.

The production environment must provide the scoped
`CLOUDFLARE_D1_ADMIN_API_TOKEN`, `CLOUDFLARE_WEB_ROLLBACK_API_TOKEN`, and
`CLOUDFLARE_PROVIDER_PROBE_API_TOKEN`, plus the restricted
`STARGATE_DEPLOY_SSH_PRIVATE_KEY` and pinned `STARGATE_DEPLOY_KNOWN_HOSTS`. The rollback token must be able to inspect
and deploy an existing `intar-dev` version; the provider-probe token must be able to run a
temporary remote Worker with the old D1 and `intar-hcloud-provider` service
bindings. CI fails closed if either scope is insufficient. No plaintext Hetzner
credential is added to GitHub: the probe uses the existing encrypted envelope
through the provider service, and emits only counts and sentinel presence.

`bootstrap-owner` requires the explicit successful `apply` run ID. It verifies
that run's repository, workflow, `main` SHA, actor, triggering actor, first
attempt, successful conclusion, and sole unexpired apply artifact. The artifact
and database marker must agree on the database name and ID, baseline hash,
source SHA, owner login and numeric GitHub ID, and apply run. The OAuth-created
state must contain exactly one `account` row whose `provider_id` is `github`,
whose `account_id` is that numeric GitHub ID, and whose `user_id` is the sole
matching user.

After `apply`, copy the recorded UUID into the protected production variable
`CLEAN_D1_DATABASE_ID` and set `CLEAN_D1_DATABASE_NAME` to
`intar-dev-control-plane-v2-20260803-r3`. The checked-in all-zero UUID is a
fail-closed build placeholder. The production web workflow replaces it only in
the built artifact, verifies the live baseline through that exact binding, and
refuses to deploy while either protected variable is absent or mismatched. The
production config also pins the existing Astro `SESSION` KV namespace
`87ad9df7e37e4ced900553aa1a7775a1`; CI proves both bindings before uploading
and again after exact-version activation.

## Cutover order

1. Validate the single baseline migration and repeatable bootstrap against fresh
   local databases.
2. Dispatch `plan` from the exact reviewed `main` SHA and retain its evidence.
3. Fully drain the old control plane, then dispatch `apply` with its exact D1
   UUID, exact active Worker version UUID, and the owner GitHub login and
   numeric ID. Retain the zero-count drain evidence, recovery and version
   activation evidence, new database ID, commissioning marker, and apply
   artifact.
4. Deploy the route-less Hetzner and GCP provider Workers independently.
5. Call each service's `capabilities()` RPC and compare the result to the
   generated protocol-v1 contract.
6. Upload the web artifact as an inert immutable version with the new D1,
   existing `SESSION` KV, and both provider service bindings, prove the exact
   bindings, then deploy that version UUID at 100 percent. Do not run the
   separate trigger deployment or regular deployment commands, so routes,
   crons, and Durable Object lifecycle stay untouched. For this first switch,
   pass the successful clean-D1
   `apply` run ID as `clean_d1_cutover_run_id`. Later deployments detect the
   already-clean active binding and do not require that input.
7. Sign in once through GitHub as the seeded owner. Do not create any
   organization yet.
8. Dispatch `bootstrap-owner` with the same GitHub login and numeric ID, the
   exact new database ID, the successful first-attempt `apply` run ID,
   confirmation `BOOTSTRAP CLEAN D1 OWNER`, and the protected single-operator
   confirmation when applicable. The operation fails closed unless the apply
   run, artifact, marker, allowlist, user, and GitHub account all match and there
   are zero organizations or memberships. It is idempotent for that identity and
   provenance.
9. Sign out and in again, confirm the user is an Intar administrator, then enable
   the `organization-creation` flag for the new user targeting key.
10. Recreate the pilot organization and republish the
    required Course, Scenario, and Workshop content through their application
    APIs. The CI rehearsal proves this clean-state shape without bypassing those
    production authorization paths.
11. Reconnect both dedicated provider projects through the owner-only BYOK APIs.
12. Keep issuance flags disabled while validating forecasts and connection
    health.
13. Run and fully delete one Hetzner learner and the two-user isolation session
    before enabling another organization. Until GCP credentials are available,
    keep the GCP provider explicitly dormant and GCP issuance disabled; defer
    the GCP learner acceptance test rather than substituting mocked evidence.

The local `bun run check:bootstrap` rehearsal does not seed or authorize the
production owner. Only the protected `apply` and `bootstrap-owner` operations
perform those two commissioning steps.

## Rollback

Rollback restores the previous web artifact and previous D1 binding together.
It does not copy rows between databases. Before switching, disable new issuance
and prove that every resource created by the new control plane is deleted or
remains visible as `cleanup_pending` to an owner. Provider Workers may remain
deployed while cleanup continues because they have no public routes.

## Evidence

Retain the reviewed commit, workflow runs, new and old D1 IDs, applied baseline
hash, old-control-plane drain JSON, apply artifact ID and digest, commissioning
receipt, provider Worker versions and capabilities, bootstrap result, content
revision IDs, forecast versions, allocation/resource/operation IDs, final cost
estimates, route IDs, and zero-resource/zero-active-slot teardown queries.
