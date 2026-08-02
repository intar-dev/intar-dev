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
when absent and applies only `migrations/0000_clean_multicloud.sql`. `rollback`
requires issuance to be disabled, verifies that the selected previous Worker
version contains the selected previous D1 binding, and restores that version.
It never deletes the new database.

Before any remote inventory or mutation, the workflow runs
`bun run check:bootstrap`. This creates a fresh in-memory database, applies the
single baseline, and repeats a deterministic owner, organization, Scenario,
Course, and Workshop publication bootstrap twice. It compares the complete
seeded state after each run and checks foreign keys. The rehearsal contains no
provider credentials and cannot reach or mutate production.

After `apply`, copy the recorded UUID into the protected production variable
`CLEAN_D1_DATABASE_ID` and set `CLEAN_D1_DATABASE_NAME` to
`intar-dev-control-plane-v2-20260801`. The checked-in all-zero UUID is a
fail-closed build placeholder. The production web workflow replaces it only in
the built artifact, verifies the live baseline through that exact binding, and
refuses to deploy while either protected variable is absent or mismatched.

## Cutover order

1. Validate the single baseline migration and repeatable bootstrap against fresh
   local databases.
2. Provision the explicitly named production D1 database and record its ID.
3. Deploy the route-less Hetzner and GCP provider Workers independently.
4. Call each service's `capabilities()` RPC and compare the result to the
   generated protocol-v1 contract.
5. Apply the baseline migration to the new database.
6. Deploy the web artifact with only the new D1 binding and both provider
   service bindings.
7. Sign in as the owner, recreate the pilot organization, and republish the
   required Course, Scenario, and Workshop content through their application
   APIs. The CI rehearsal proves this clean-state shape without bypassing those
   production authorization paths.
8. Reconnect both dedicated provider projects through the owner-only BYOK APIs.
9. Keep issuance flags disabled while validating forecasts and connection
   health.
10. Run and fully delete one Hetzner learner, one GCP learner, and the two-user
    isolation session before enabling another organization.

## Rollback

Rollback restores the previous web artifact and previous D1 binding together.
It does not copy rows between databases. Before switching, disable new issuance
and prove that every resource created by the new control plane is deleted or
remains visible as `cleanup_pending` to an owner. Provider Workers may remain
deployed while cleanup continues because they have no public routes.

## Evidence

Retain the reviewed commit, workflow runs, new and old D1 IDs, applied baseline
hash, provider Worker versions and capabilities, bootstrap result, content
revision IDs, forecast versions, allocation/resource/operation IDs, final cost
estimates, route IDs, and zero-resource/zero-active-slot teardown queries.
