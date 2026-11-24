# Intar website

`apps/web` is the learner UI and the control plane, deployed as one Cloudflare
Worker at [intar.dev](https://intar.dev). The UI is an Astro site with React.
The control plane is the Worker's API: it holds accounts, the course catalog,
the image registry, and the desired state of every host.

`AGENTS.md` in this directory has the rules for changes here, and `DESIGN.md`
and `PRODUCT.md` describe the design system and the product.

## Layout

| Path | Contents |
| --- | --- |
| `src/pages` | The Astro entry points. `src/pages/api` is the HTTP API |
| `src/components`, `src/hooks`, `src/styles` | The React UI |
| `src/control-plane` | Host enrollment, the Durable Objects, CPU reservations, the image registry, run artifacts |
| `src/lib` | Everything else behind the API: auth, organizations, catalogs, runs |
| `src/db/schema` | The database schema. `migrations/` is generated from it |
| `src/generated` | Types and fixtures generated from `crates/intar-contracts`. Never edit them; run `cuenv task generate-contracts` |
| `workers/image-registry-cleanup` | A second Worker, which deletes unreferenced registry blobs |
| `tests/ui` | The Playwright suites. [README](tests/ui/README.md) |
| `wrangler.jsonc`, `wrangler.local.jsonc` | The production Worker configuration, and the local one |

## Running it locally

Use the Node.js version in `.node-version`; the Astro build needs runtime APIs
that older Node 22 patch releases lack. From the repository root, install the
dependencies once with `cuenv task install-js`. Then, in `apps/web`:

```bash
bun dev
```

The site is at `http://localhost:4321`. `astro dev` uses
`wrangler.local.jsonc`: D1, R2, the Durable Objects and the rate limits are
simulated on your computer, and there is no production route or VPC service
binding. Secrets go in `.dev.vars`, which git ignores; signing in needs at
least `BETTER_AUTH_SECRET` and a GitHub OAuth app's `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` (see "Worker configuration" below).

A local site has no hosts, so nothing runs there until a host enrolls with it.

## Checks and tests

| Command, in `apps/web` | What it runs |
| --- | --- |
| `bun run test` | The unit tests (`*.test.ts`, Node) and the Worker tests (`*.workers.test.ts`, in workerd) |
| `bun run test:node`, `bun run test:workers` | Either half |
| `bun run build` | The Cloudflare type checks, `astro sync`, `tsc --noEmit`, and the build |
| `bun run test:ui` | The Playwright suites; see [`tests/ui/README.md`](tests/ui/README.md) |
| `bun run types:cf` | Regenerates `worker-configuration.d.ts` after a change to `wrangler.jsonc` |

From the repository root, `bun run check` adds the import boundaries, the
deploy tooling's tests and the migration checks, and `cuenv task lanes.web`
runs what CI runs for the website.

## Database

The TypeScript tables under `src/db/schema/` are the only source of the
schema. Drizzle Kit generates the ordered `migrations/*.sql` stream and its
`migrations/meta/` provenance from them. Never edit those generated files, use
`drizzle-kit generate --custom`, add SQL triggers, or create migrations
through Wrangler.

```bash
bun run db:generate             # after a schema change; commit what it writes
bun run db:check
bun run db:migrate:production   # the deploy runs this
```

`db:generate` keeps only the latest Drizzle snapshot. The SQL stream and
journal keep the complete migration history. Generation and checks need no
Cloudflare credentials. Remote migration uses Drizzle Kit's D1 HTTP driver and
requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and either
`CLOUDFLARE_D1_TOKEN` or `CLOUDFLARE_API_TOKEN`. Do not apply schema files
with `wrangler d1 execute`, run Wrangler's D1 migration commands, or edit
either migration ledger by hand.

## How scenario control works

Scenario control is desired-state based:

- D1 stores scenario runs plus each host's desired and reported actual state.
- The Host Runtime Durable Object owns the live agent WebSocket and reconciles
  full desired-state documents with host reports.
- Agents and builders reconnect, request the latest document, and continue
  converging from their local SQLite state.
- R2 stores immutable VM images, source bundles, build logs, and run artifacts.

Host CPU reservations use exact millicores and count pending plus committed
rows against schedulable capacity.

The contracts between the Worker and the hosts are Rust types in
`crates/intar-contracts`; the bridge is `src/bridge_v9.rs` there. A message of
a version the Worker does not support is rejected, never translated.

## Deploying

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

Every deploy holds the image registry cleanup worker before it changes
anything and releases it at the end, also after a failure. The worker runs in
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
The website deploy sets it from `tools/deploy/kino-pin.json`, which the release
workflow writes; without that file the variable is unset and no VM is placed.

### Recovery after a failed migration deploy

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

## Worker configuration

Non-secret values and the Cloudflare resource bindings are declared in
`wrangler.jsonc`; regenerate `worker-configuration.d.ts` with
`bun run types:cf` after changing them. The Worker also expects these secrets:

- `AGENT_JWT_SECRET` (a randomly generated secret of at least 32 UTF-8 bytes)
- `BETTER_AUTH_SECRET`
- `CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, the OAuth app people sign in
  with
- `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET`, the GitHub App
  that reads scenario repositories
- `REGISTRY_PUBLISH_TOKEN`
- `SCENARIO_RUN_KEY_ENCRYPTION_SECRET`
- `STARGATE_ADMIN_AUTH_SECRET`
- `STARGATE_ADMIN_BASE_URL`, only when the configured VPC service binding is
  not used

The rest of this file describes how accounts behave, for whoever changes or
supports them.

## Sign-ups

Anyone can create an account with GitHub, or through an organization's
identity provider, while sign-up spots are open. Administrators set the limit
under **Admin → People → Sign-ups**. Every active account with at least one
sign-in identity takes a spot, administrators included; connecting a second
sign-in method never takes another. Revoking or deleting someone frees their
spot, and restoring their access takes one again, even past the limit. Until a
limit is saved, the limit is 0 and sign-ups are closed. Lowering
the limit never removes anyone; it only stops new sign-ups. Members can always
sign in, and the landing page shows how many spots are left.

The spot is claimed atomically when a new member's first identity is linked,
so concurrent sign-ups for the last spot admit exactly one person.

An email address never links accounts someone can sign in to. When a sign-in's
email belongs to an account that isn't connected to that identity, the sign-in
is refused: sign in to the existing account, then connect the other method (an
organization from its sign-in page, GitHub from **Profile**). The exception is
an account nobody can sign in to anymore, for example because its only
organization identity was removed with the provider: a GitHub sign-in with the
same verified email takes it over, and so does an organization sign-in that
could have created it, when that organization signed the account up or the
address is verified and on its provider's verified domain. Organization
sign-ups record the email as verified only on that domain. An approved
provider's other addresses stay unverified, so GitHub never takes those
accounts over, and only their own organization can. Platform admins always
keep GitHub, so their accounts are never taken over this way.

**Profile** lists the account's sign-in methods by organization. Disconnecting
GitHub or an organization there signs out every other session and connected
app. The last way to sign in can't be disconnected, and neither can an
organization identity whose admins removed the person, until they restore
them. Connecting or disconnecting GitHub or an organization needs a sign-in
from the last day, and a connection finishes only while the session that
started it is still signed in and can act. Usernames come only from GitHub, so disconnecting GitHub
clears the username. Sessions an admin opens by impersonating someone can't
connect or disconnect sign-in methods, or authorize apps or widen their
access. They stop working as soon as that admin is no longer one who can sign
in, and end when the admin is demoted, revoked, or signed out.

A session lasts only while its account can still sign in: every API request
checks that some identity still can, and a sign-in's new session needs the
identity it came through. Platform admins sign in with GitHub only: an
organization's owners and admins control its provider and decide who
administers it, so no organization provider signs in a platform admin.
Promoting someone to platform admin therefore needs GitHub, and signs them out,
since an organization's provider may have opened those sessions. Guards that
keep the last platform admin, on demotion, revocation, and deletion, count
only admins who can still sign in.

Revoking access signs the person out: they keep their data but can no longer
sign in, and their sessions, connected apps, runs, routes, pending server
registrations, and personal servers are shut down. Once that cleanup finished,
an administrator can restore their access from the person's page under
**Admin → People**, as a fresh start on the same account. They keep their
sign-in methods, history, and an organization they alone own; their SSH keys,
the apps they registered, their other organization memberships, and the admin
role are removed, their personal servers are retired, and new runs use the
cloud. Nothing the revocation ended comes back: every check that brackets an
operation compares the account's access generation, which each revocation
advances, so an operation that started before a revocation fails even when it
finishes after a restore. Restoring also signs out anything that raced in.

Deleting a user revokes access first, then anonymizes the account. A deleted
person can sign up again while spots are open. Revocation, restore, and
deletion events keep the person's GitHub account id and first organization
identity (provider and subject), so the audit trail outlives the account rows.

## Organizations

Organizations are visible to every signed-in member, but organization creation is
controlled by the generic Cloudflare Flagship binding named `FLAGS`. The
`organization-creation` boolean flag defaults to `off`; targeting rules should
serve `on` only when the `targetingKey` context field matches a selected Better
Auth user ID. The toggle controls creation only—it is not an authentication or
authorization boundary.

The `builder_operations` boolean flag, evaluated the same way for the platform
administrator who reads, also defaults to `off`. While it is off, the admin
navigation has no "Builds" entry and host enrollment offers no "Builder" role:
scenario repositories build their own images, and the builder is the fallback.
Serve `on` to show both again. Nothing else depends on it: the builds page and
its API stay reachable at `/admin/builds`, the enrollment API still accepts a
builder from a platform administrator, enrolled builders keep working, and a
scenario source card links to its builds whenever a builder builds for it.

### Organization OIDC

An organization admin can configure one OIDC provider and a domain the
organization controls. After the admin publishes the requested DNS TXT record,
people sign in at `/organization-sign-in` or `/organizations/<slug>/sign-in`
(the member sign-in URL in organization settings):

- A new identity gets an Intar account and joins the organization as a member.
  Its email must be on the verified domain (subdomains count). Emails on other
  domains need a platform admin's approval for that provider (**Admin →
  People → Organizations → Manage**, or the **New accounts** control in
  organization settings), and the provider must mark them `email_verified`.
  Sign-ups take a spot like GitHub sign-ups.
- An identity is its provider subject. Later sign-ins bind to it, whatever
  email the provider sends, and require an active account.
- Someone already signed in who continues on the organization sign-in page
  connects the identity to that account, whatever its email. The
  organization's provider can then sign in as them, except as a platform
  admin, who signs in with GitHub only; no organization sign-in takes over a
  platform admin's account. The owner's **Test sign-in** in settings runs this
  flow and returns with the result.
- Signing in through the provider makes the person a member. An admin who
  removes a member also blocks them from the provider until an admin restores
  them under **People**, or a platform admin under **Admin → People →
  Organizations**. If they have an identity at the provider, they are signed
  out everywhere in the same transaction: a session doesn't record which
  identity opened it. Platform admins, who sign in with GitHub only, stay
  signed in. The block also covers the logins (issuer and subject) they had at
  the organization's providers, so those can't sign in to, sign up or connect
  any account, even after the person is deleted or the provider is registered
  again. Admins leave instead of removing themselves. Leaving an organization
  blocks nothing.

Every flow starts from Intar's own routes, which sign an intent that the
callback enforces; Better Auth's `/api/auth/sign-in/sso` refuses requests
without one. SAML routes are disabled; organization SSO is OIDC-only.

Register Intar at the identity provider as a public client without a client
secret. Use the callback URI shown in organization settings; it is built from
`BETTER_AUTH_URL`. Discovery must advertise response type `code`, PKCE method
`S256`, and token authentication method `none`. Intar requests
`openid email profile`, always uses authorization code flow with PKCE S256,
and validates the signed ID token against the provider's JWKS, the issuer
exactly as discovery advertises it, and the client ID. The ID token must
include the `email` claim; without it, sign-in and connecting stop with a
message asking the provider's admin to add it. Implicit flow, hybrid flow,
plain PKCE, and clients with secrets are not supported.

For a Better Auth identity provider that uses the legacy `oidcProvider` plugin
(such as `https://id.rawkode.academy`), register Intar as a trusted public
client:

```ts
{
  clientId: "intar",
  name: "Intar",
  type: "public",
  // Better Auth's legacy provider expects a value even for public clients.
  clientSecret: "pkce-public-client-placeholder",
  redirectUrls: ["<callback URI from organization settings>"],
  disabled: false,
  skipConsent: true,
  metadata: null,
}
```

The SSO dependency patch in `patches/` enables token authentication `none` and
lets Intar bind an explicit link to the signed-in account; see
`patches/README.md`.

Removing the provider is refused while active members have no other usable
way to sign in. Otherwise removal signs out everyone with an identity at it,
except the admin removing it in their current session, and deletes the linked
identities in one transaction that rechecks the members; members keep their
memberships and other sign-in methods, and people left without a way in can
reclaim their account as described under Sign-ups. Server-side sign-outs delete sessions
and OAuth tokens in the transaction that takes access away, so a refused
change signs nobody out; they include the sessions the person opened by
impersonating someone. Back-channel logout isn't sent: Better Auth's OAuth
provider delivers it with a fetch option Workers doesn't support. Terminal
routes opened before a sign-out keep working until they expire
(`STARGATE_ROUTE_TTL_SECONDS`, four hours by default); only revoking access
closes them early. Existing
providers that use secrets cannot sign in: remove their configuration and
register a public client.

Private scenarios use the `<organization-slug>-<local-scenario-id>` namespace.
Their images are built by a platform builder, or by the repository's own
pipeline once a platform administrator sets the scenario source to it, and
they can run only on agent runners owned by
the same organization. Organization runner bootstrap credentials remain valid
until rotation, revocation, host disablement, or deletion; the access JWTs they
mint remain short-lived.
