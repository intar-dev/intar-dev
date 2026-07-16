# intar website

The `website/` app is the learner UI and Cloudflare-based control plane for Intar.

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

Run from `website/`:

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
git or CI. Never commit files from `website/src/generated/scenario-wasm/`.

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
hand. The production workflow deploys the new Worker before applying pending
migrations, so schema-removal migrations must remain safe during the brief
new-code/old-schema interval.

Pull requests run the test/build and UI quality gates. A merge to `main` that
changes the website automatically builds that exact commit and deploys it
through the `Website production` workflow; do not deploy an ignored local
`dist/` artifact directly. The production workflow creates the deployable Astro
artifact but does not repeat the pull request quality gates. Treat `main` as
deploy-only: a direct website push bypasses those gates and deploys immediately.

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
