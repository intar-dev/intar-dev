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
