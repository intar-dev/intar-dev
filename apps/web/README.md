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
bun run db:migrate:local
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

`migrations/*.sql` is the canonical ordered D1 migration stream. Wrangler
records each applied filename in its `d1_migrations` ledger, so both fresh and
existing databases use the same command without a hand-maintained starting
point:

```bash
bun run db:migrate:local
bun run db:migrate:production
```

Create future migrations with `wrangler d1 migrations create DB <name>`. Do not
apply schema files with `wrangler d1 execute` or edit the migration ledger by
hand. The production workflow builds the exact commit, applies pending
migrations, and then deploys the new Worker. The deployment is forward-only: a
migration must leave the currently deployed Worker functional enough for the
short interval before replacement.

Pull requests run the test/build and UI quality gates. A merge to `main` that
changes the website automatically builds that exact commit and deploys it
through the `Website production` workflow; do not deploy an ignored local
`dist/` artifact directly. The production workflow creates the deployable Astro
artifact but does not repeat the pull request quality gates. Treat `main` as
deploy-only: a direct website push bypasses those gates and deploys immediately.

## Beta-access replacement cutover

Beta access is a clean replacement, not a D1 migration. Do not merge or deploy
this Worker through the normal migration-first production job while
`BETA_ACCESS_MAINTENANCE` is off. There is no old-Worker rollback after the
reset.

1. Set a production-environment `BETA_MAINTENANCE_BYPASS_SECRET`; use at least
   32 random bytes. The protected website deployment passes it to Wrangler's
   secrets file without logging it.
2. While the current Worker and old beta schema are still active, end every
   active scenario run (including hidden runs and a user-owned run on an
   organization runner), disconnect all personal agents, and close every issued
   workshop terminal/application route. The replacement Worker cannot perform
   this drain before the schema reset: its authorization queries intentionally
   understand only the new allowlist shape.
3. Deploy the Worker with `BETA_ACCESS_MAINTENANCE` set to `on`. Verify an
   unauthenticated `/api/*` request returns HTTP 503 with
   `{"code":"maintenance"}`. Keep maintenance enabled for at least one hour
   before cutover. The replacement disables Better Auth's generic `/token`
   endpoint, but wait at least 15 minutes for JWTs issued by the previous Worker
   to expire. It also rejects OAuth resource/audience requests so every newly
   issued OAuth access token is opaque and immediately revocable; wait the full
   hour for any resource JWT minted by the previous Worker to reach its maximum
   lifetime.
4. In the browser used for the smoke test, establish the two-hour operator
   bypass from the maintenance page's DevTools console. This keeps the secret
   out of URLs and request logs:

   ```js
   await fetch("/api/maintenance/bypass", {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ secret: prompt("Maintenance bypass secret") }),
   });
   ```

   If a Stargate create or delete result from the pre-deploy drain was
   ambiguous, wait out its four-hour maximum TTL before continuing. The cutover
   command rejects live or recently terminal scenario routes and never disables
   or deletes an organization-owned runner.
5. Run the destructive command with a new, protected, absolute checkpoint path and the
   known existing Better Auth administrator. It verifies maintenance and
   provider-account uniqueness, exports D1, replaces only beta tables and
   account indexes, removes sessions/OAuth grants/personal credentials, then
   prints one bootstrap fragment link exactly once:

   ```sh
   bun run beta:cutover -- \
     --remote \
     --admin-user-id ADMIN_USER_ID \
     --export /secure/checkpoints/intar-before-beta-cutover.sql \
     --confirm-pure-replacement
   ```

6. Redeem the bootstrap link as that administrator. Create and claim a normal
   invite, connect organization SSO, revoke the test user, and verify app,
   OAuth, personal-agent bootstrap, and personal-route denial while an
   organization runner remains healthy.
7. Change `BETA_ACCESS_MAINTENANCE` to `off` and deploy the same forward-fixed
   Worker only after the smoke checks pass. A failure stays in maintenance and
   is fixed forward; the checkpoint is catastrophe recovery, not an
   application rollback.

Beta revocation cleanup uses a non-expiring D1 execution lock. Concurrent
retries cannot run capability cleanup twice or delete routes created after a
later admission. A timeout after dispatching an external route/runtime delete
is recorded as `access.revocation_cleanup_stalled` and deliberately retains the
lock because the remote operation may still finish. The same applies if a
Worker is terminated mid-cleanup. Put the app in maintenance, prove that the
recorded attempt and remote operations are no longer executing, and release it
through an `access.revocation_cleanup_failed` audit insert carrying the exact
user, revocation, and cleanup-attempt IDs with reason
`operator_abandoned_cleanup`. The D1 trigger atomically records that failure and
releases only that attempt; then retry the normal beta-user revoke endpoint.
Never clear the lock with a direct allowlist update or while the original
execution may still be live.

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
