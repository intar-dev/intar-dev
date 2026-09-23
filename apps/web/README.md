# intar website

The `apps/web/` app is the learner UI and Cloudflare-based control plane for Intar.

## Architecture

Scenario control is desired-state based:

- D1 stores scenario runs plus each host's desired and reported actual state.
- The Host Runtime Durable Object owns the live agent WebSocket and reconciles
  full desired-state documents with host reports.
- Agents and builders reconnect, request the latest document, and continue
  converging from their local SQLite state.
- R2 stores immutable VM images, source bundles, build logs, and run artifacts.

The committed Rust contracts generate the TypeScript bridge types and fixtures in
`src/generated/`; do not hand-edit those generated files.

Scenario catalog manifests are V4. The bridge envelope is V7; its desired-state,
host-state-report, and VM-report schemas are V4, V5, and V4. Build reports use
schema V1. Unsupported contract versions are rejected rather than translated.
Host CPU reservations use exact millicores and count pending plus committed
rows against schedulable capacity.

## Useful commands

Use the Node.js version pinned in `.node-version`; the Astro build relies on
runtime APIs that are not present in older Node 22 patch releases.

Run from `apps/web/`:

```bash
bun dev
bun run test
bun run build
bun run db:generate
bun run db:check
bun run dev
```

`astro dev` automatically uses `wrangler.local.jsonc`. Its D1, R2, Durable
Object, and rate-limit bindings are simulated locally and it intentionally has
no production route or VPC service binding. Production checks and builds keep
using `wrangler.jsonc`.

The TypeScript tables under `src/db/schema/` are the sole database schema
source of truth. Drizzle Kit generates the ordered `migrations/*.sql` stream and
its `migrations/meta/` provenance. Never edit those generated files, use
`drizzle-kit generate --custom`, add SQL triggers, or create migrations through
Wrangler.

`db:generate` keeps only the latest Drizzle snapshot. The SQL stream and journal
keep the complete migration history.

```bash
bun run db:generate
bun run db:check
bun run db:migrate:production
```

Generation and checks do not need Cloudflare credentials. Remote migration uses
Drizzle Kit's D1 HTTP driver and requires `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_DATABASE_ID`, and either `CLOUDFLARE_D1_TOKEN` or
`CLOUDFLARE_API_TOKEN`. Do not apply schema files with `wrangler d1 execute`,
run Wrangler's D1 migration commands, or edit either migration ledger by hand.
Pull requests run the web tests, build, and one Chromium smoke check. A matching
push to `main` runs the same fixed lane and then deploys its tested artifact
automatically. The deploy verifies the exact source revision and production
bindings, applies pending Drizzle migrations, deploys the full Worker
configuration at 100 percent, and checks the homepage, favicon, and D1-backed
health API.

Maintenance mode is enabled only when a migration is pending. The workflow
drains old requests before applying that migration. It does not roll back: a
failed post-migration activation leaves maintenance enabled, and a failed live
check leaves the deployed version active while the workflow reports failure.

## Sign-ups

Anyone can create an account with GitHub while sign-up spots are open.
Administrators set the limit under **Admin → People → Sign-ups**. Every active
account with a linked GitHub identity takes a spot, administrators included.
Revoking or deleting someone frees their spot. Until a limit is saved, the limit
is 0 and sign-ups are closed. Lowering the limit never removes anyone; it only
stops new sign-ups. Members can always sign in, and the landing page shows how
many spots are left.

The spot is claimed atomically when the new member's GitHub account is linked,
so concurrent sign-ups for the last spot admit exactly one person. GitHub is the
only way to create an account; organization OIDC only links to an existing
account.

Revoking access is permanent: the person keeps their data but can no longer
sign in, and their sessions, runs, routes, and personal servers are shut down.
Deleting a user revokes access first, then anonymizes the account. A deleted
person can sign up again while spots are open.

## Organizations

Organizations are visible to every signed-in member, but organization creation is
controlled by the generic Cloudflare Flagship binding named `FLAGS`. The
`organization-creation` boolean flag defaults to `off`; targeting rules should
serve `on` only when the `targetingKey` context field matches a selected Better
Auth user ID. The toggle controls creation only—it is not an authentication or
authorization boundary.

An organization admin can configure one verified OIDC provider and domain.
The callback URI shown in the organization settings must be registered at the
identity provider. After the admin publishes the requested DNS TXT record,
a member signed in with GitHub connects that provider explicitly at
`/organization-sign-in` or `/organizations/<slug>/sign-in`. Later sign-ins bind
to the stable provider subject and require an active account. OIDC never
creates an account: new people sign up with GitHub first. Already-linked active
OIDC identities can sign in normally. SAML routes are disabled; organization
SSO is OIDC-only.

Register Intar at the identity provider as a public client without a client
secret. Use the callback URI shown in organization settings. Discovery must
advertise response type `code`, PKCE method `S256`, and token authentication
method `none`. Intar always uses authorization code flow with PKCE S256 and
validates the signed ID token against the provider's JWKS, issuer, and client ID.
Implicit flow, hybrid flow, plain PKCE, and clients with secrets are not supported.

After DNS verification, owners can select **Test sign-in** in organization
settings. The test connects their OIDC account through the normal PKCE flow and
returns to settings with the result.

The SSO dependency patch in `patches/` enables token authentication `none`
in the pinned Better Auth release.

Existing providers that use secrets cannot sign in. Remove their organization
OIDC configuration and register a public client. Removal deletes linked OIDC
accounts, so members must connect the new provider from their GitHub accounts.
The organization OIDC flow no longer needs an encryption key.

Private scenarios use the `<organization-slug>-<local-scenario-id>` namespace.
They are built by platform builders and can run only on agent runners owned by
the same organization. Organization runner bootstrap credentials remain valid
until rotation, revocation, host disablement, or deletion; the access JWTs they
mint remain short-lived.

## Worker configuration

The control plane expects these Worker secrets/vars:

- `AGENT_JWT_SECRET` (a randomly generated secret of at least 32 UTF-8 bytes)
- `BETTER_AUTH_SECRET`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- `REGISTRY_PUBLISH_TOKEN`
- `SCENARIO_RUN_KEY_ENCRYPTION_SECRET`
- `STARGATE_ADMIN_AUTH_SECRET`
- `STARGATE_ADMIN_BASE_URL` only when the configured VPC service binding is not
  used

Non-secret defaults and Cloudflare resource bindings are declared in
`wrangler.jsonc`; regenerate `worker-configuration.d.ts` after changing them.
