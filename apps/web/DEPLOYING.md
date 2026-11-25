# Deploying the website

Nobody deploys by hand. The merge queue builds the website when a pull request
changes it, and when the queue moves `main`, the Deploy workflow deploys that
build ([`ci/README.md`](../../ci/README.md) has the details). The deploy
verifies the exact source revision, the build's digest, and the production
bindings, applies pending Drizzle migrations, deploys the full Worker
configuration at 100 percent, and checks the homepage, favicon, and D1-backed
health API.

Maintenance mode is enabled only when a migration is pending. The workflow
drains old requests before applying that migration. It does not roll back: a
failed live check leaves the deployed version active while the workflow
reports failure, and a failure after maintenance was enabled leaves maintenance
serving until the next deploy recovers it (below). The job summary of every
deploy names the Worker version that served before the run and the
`bunx wrangler rollback <id> --name intar-dev` command for it. That rollback is
the break-glass path for the Worker only: D1 migrations don't roll back.

A deploy with a pending D1 migration holds the image registry cleanup worker
before it changes anything and releases it at the end, also after a failure.
Any other deploy that keeps the worker's mode places no hold: the collector's
roots don't change under it, since it treats every Kino artifact as a root and
deletes nothing younger than a day. That deploy still clears a hold an earlier
deploy left, and checks D1 upload admission before it redeploys a deleting
worker. A mode change takes the full hold. The worker runs in
the mode committed in `workers/image-registry-cleanup/wrangler.jsonc`; image-ops
`cleanup-run` and the worker's 6-hour cron do the deleting. In `delete` mode the
hold also needs D1 upload admission enforcement. If it has been switched off,
re-enable it with `POST https://intar.dev/registry/v1/admission/enforcement`,
body `{"mode":"enforce"}` and `Authorization: Bearer $INTAR_IMAGE_PUBLISH_TOKEN`,
or commit `report-only` as the worker mode.

Hosts take Kino as a stored Kino artifact. `KINO_PINS_JSON` pins one per
guest contract, as `{"<contract>":{"current":"sha256:<hex>","previous":null}}`;
a pin whose digest is not a stored Kino artifact for that contract pins nothing.
That pair is the amd64 Kino, which hosts run. An `"arm64":{"current":...,"previous":...}`
pair nested in the entry pins the arm64 Kino, which a learner's arm64 computer
runs; without it no local run starts there.
The website deploy resolves it from the published Kino releases
(`tools/deploy/release-pins.ts`): per contract and architecture, the newest
attested release whose artifact the registry stores is current, and the stored
one before it previous. Without one the variable is unset and no VM is placed.

## Recovery after a failed migration deploy

The collector's gate route sits behind the maintenance fence, so the deploy
states are:

1. **Open.** A deploy holds the collector through the gate: it reads the D1
   admission state, in `delete` mode takes a report inventory, then pauses the
   collector and waits for it to be idle. With migrations pending it then
   deploys a maintenance version, tagged `web-<sha12>-maintenance`.
2. **Maintenance left serving.** The run failed after it enabled maintenance:
   at the drain, the migration, the schema check, or the collector or
   production deploy. Its release meets its own maintenance version, leaves the
   collector held, and passes; the step that failed is the one that reports.
   The fenced collector can't sweep, and nothing can reach it to release it.
3. **Recovery.** The next deploy, a fix push, a Deploy dispatch from `main`,
   or a re-run while its revision is still `main`'s tip, finds a
   `web-<sha12>-maintenance` version serving with maintenance on. Its hold reads
   the D1 admission row instead of the gate and requires that no sweep is in
   flight and, in `delete` mode, that upload admission is enforced. The run
   then applies the migrations that are still pending under its own
   maintenance version, verifies the schema, deploys the collector in the
   committed mode, and deploys production, which reopens the site. Its release
   goes through the open gate and resumes the collector (state 1). If it fails
   again, the state stays 2 and the next deploy recovers. When CI on `main`'s
   tip fails outside the web lane, for example on a newly published advisory,
   no deploy follows it: dispatch Deploy with break glass
   (`gh workflow run deploy.yml --ref main -f break_glass=true`), which deploys
   the tip's build once its own web lane and Chromium smoke passed.

A recovery hold has no report inventory, because the fenced collector can't
plan, so it deploys `delete` only over a collector that already deletes. It
never turns deletes on. Maintenance that this lane didn't deploy still stops
the hold.

A release can also fail while the site serves, for example on a transient gate
error. The collector then stays paused with the deploy's own pause reason,
`registry_cleanup_hold`, and a paused collector refuses the report inventory a
`delete` hold takes. Website deploys run one at a time, so the next deploy's
hold treats that pause as a leftover: it resumes it, takes the inventory, and
pauses again, and the hold evidence records the resume under `leftover_hold`.
The hold doesn't resume a pause with another reason, such as an operator's
pause through `/registry/v1/admission/pause`, or a collector with a sweep in
flight; a `delete` hold then fails on its inventory before it pauses, and the
release leaves the collector as the hold found it, so the operator's pause
stays. A hold that does pause, such as a `report-only` one, replaces an
existing reason with `registry_cleanup_hold`, and its release resumes the
collector. Pause a `report-only` collector again after a website deploy if it
must stay paused.
