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
`src/generated/`; do not hand-edit those generated files. The browser scenario
validator under `src/generated/scenario-wasm/` is different: it is an ignored
build artifact. CI builds it once on Linux and shares it with the website test
and UI jobs, while the production workflow rebuilds it from the exact deployed
commit.

Scenario catalog manifests are V3, the bridge envelope is V6, and its
desired-state/resource/capacity/report documents are V2. Unsupported contract
versions are rejected rather than translated.
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

Before the first local website command, build the ignored browser validator
from the repository root:

```bash
just generate-scenario-wasm
```

Local macOS and Linux output may differ byte-for-byte; that no longer affects
git or CI. Never commit files from `apps/web/src/generated/scenario-wasm/`.

`astro dev` automatically uses `wrangler.local.jsonc`. Its D1, R2, Durable
Object, and rate-limit bindings are simulated locally and it intentionally has
no production route or VPC service binding. Production checks and builds keep
using `wrangler.jsonc`.

The TypeScript tables under `src/db/schema/` are the sole database schema
source of truth. Drizzle Kit generates the ordered `migrations/*.sql` stream and
its `migrations/meta/` provenance. Never edit those generated files, use
`drizzle-kit generate --custom`, add SQL triggers, or create migrations through
Wrangler.

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
The production workflow builds the exact commit, applies pending Drizzle
migrations, and then deploys the new Worker. A forward migration must leave the
currently deployed Worker functional for the short interval before replacement.

A deliberate database rebaseline uses two reviewed exact-`main` commits. From
the first, dispatch `Prepare fresh production D1` with the exact confirmation
and a new unique production name. That workflow creates one EU-jurisdiction D1,
applies only the generated Drizzle stream, verifies the exact Drizzle ledger and
canonical generated DDL (including table definitions, indexes, constraints, and
the ledger table itself), proves that views, triggers, and foreign-key
violations are absent, empirically proves REST batch rollback, and retains its
UUID without changing the Worker. Put that evidence-backed name and UUID into
`wrangler.jsonc` in the second commit.

Deploy the second commit with `fresh_d1_cutover=true`, the exact cutover
confirmation, the separate `ARCHIVE SOURCE SNAPSHOT AND RESET CONTROL PLANE`
acknowledgement, and both source and target name/UUID pairs. This is an
explicit snapshot reset, not a lossless in-place database migration. The
protected run
fences the source Worker, performs the allowlisted durable-data copy, switches
to the target while still fenced, re-verifies schema and data-copy evidence,
then re-fingerprints every source application table and requires the source Time
Travel bookmark to remain unchanged before it opens the target. While this
fence is active, the maintenance bypass permits only GET/HEAD requests to the
DB-independent `/api/maintenance/status` endpoint; application and OAuth routes
cannot bypass maintenance, and no application mutation is permitted. The
workflow retains the source bookmark captured immediately before fencing, but
never restores it automatically. Any Phase A activation failure restores
source/open; a copy or Phase B activation failure leaves source/maintenance;
and copied-target/source-stability verification or Phase C activation failure
leaves target/maintenance. The workflow never deletes the source D1; keep it as
immutable rollback evidence, and do not switch back after the target has
accepted writes.

Maintenance prevents new application mutations but cannot cancel a Worker
invocation that started on the previous version. The final source fingerprint
and bookmark catch writes completed before that check. A later write remains
recoverable in the retained source archive but is deliberately outside the new
control-plane snapshot. Drain externally active work first and treat provider,
R2, route, and agent inventories as separate cleanup surfaces.

Pull requests run the test/build and UI quality gates. Production is not
automatic on merge: first dispatch `Website` against the exact `main` commit,
then dispatch the protected `Website production` workflow only after that
validation succeeds. The production workflow rebuilds the committed source; it
never deploys an ignored local `dist/` artifact and does not repeat all
validation gates.

## Organizations

Organizations are visible to every active beta user, but organization creation is
controlled by the generic Cloudflare Flagship binding named `FLAGS`. The
`organization-creation` boolean flag defaults to `off`; targeting rules should
serve `on` only when the `targetingKey` context field matches a selected Better
Auth user ID. The toggle controls creation only—it is not an authentication or
authorization boundary.

An organization admin can configure one verified OIDC provider and domain.
The callback URI shown in the organization settings must be registered at the
identity provider. After the admin publishes the requested DNS TXT record,
an active GitHub beta user connects that provider explicitly at
`/organization-sign-in` or `/organizations/<slug>/sign-in`. Later sign-ins bind
to the stable provider subject and dynamically require active beta access.
Existing SSO-only identities recover by opening an invite, authenticating the
already-linked OIDC subject, explicitly linking GitHub, and confirming the
claim. The installed Better Auth SAML RelayState does not preserve protected
server context, so invite recovery and new account linking fail closed for
SAML; already-linked active SAML identities can still sign in normally.

For Rawkode Academy, use issuer `https://id.rawkode.academy`. Discovery maps
that issuer to `/auth/oauth2/authorize`, `/auth/oauth2/token`,
`/auth/oauth2/userinfo`, and `/auth/jwks`. Register Intar at the Rawkode
identity service as a confidential client using the callback URI shown by
Intar and either `client_secret_basic` or `client_secret_post`; PKCE remains
enabled. Rawkode's existing public-client entries use token authentication
`none`, which the Better Auth SSO client does not support.

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
