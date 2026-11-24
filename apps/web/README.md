# Intar website

`apps/web` is the learner UI and the control plane, deployed as one Cloudflare
Worker at [intar.dev](https://intar.dev). The UI is an Astro site with React.
The control plane is the Worker's API: it holds accounts, the course catalog,
the image registry, and the desired state of every host.

Three more files in this directory go deeper: [`DEPLOYING.md`](DEPLOYING.md)
on how a deploy runs and how to recover a failed one,
[`ACCOUNTS.md`](ACCOUNTS.md) on sign-ups, organizations and single sign-on,
and [`AGENTS.md`](AGENTS.md) on the rules for changes here.

## Where things are

- The HTTP API is `src/pages/api`. What it calls into is `src/control-plane`
  (hosts, the Durable Objects, CPU reservations, the image registry) and
  `src/lib` (everything else: auth, organizations, catalogs, runs).
- `src/db/schema` is the database schema, and `migrations/` is generated from
  it.
- `src/generated` is generated from the Rust contracts in
  `crates/intar-contracts`. Run `cuenv task generate-contracts`; never edit
  it.
- `workers/image-registry-cleanup` is a second Worker, which deletes
  unreferenced registry blobs. It is deployed with the website.

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
