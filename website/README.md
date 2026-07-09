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
`src/generated/`; do not hand-edit those generated files.

## Useful commands

Use the Node.js version pinned in `.node-version`; the Astro build relies on
runtime APIs that are not present in older Node 22 patch releases.

Run from `website/`:

```bash
bun dev
bun run test
bun run build
bunx wrangler d1 execute DB --local --file drizzle/0000_baseline.sql --config wrangler.jsonc
bunx wrangler dev --config dist/server/wrangler.json --port 8788
```

`drizzle/0000_baseline.sql` is reset-only. Schema changes intentionally do not
support in-place upgrades. The committed all-zero D1 ID is a deployment guard;
replace it only as part of the complete remote cutover below.

Production deploys run only through the manually confirmed `Website` workflow
on `main`; do not deploy an ignored local `dist/` artifact directly.

## Breaking remote reset cutover

Do not discard the old D1 database first. It is the only index for run-artifact
and build-log objects in the old R2 buckets. Rotate the two R2 buckets and D1 as
one generation so the old D1 and old buckets can later be retired together.

From `website/`, while authenticated to the intended Cloudflare account:

```bash
export RESET_SUFFIX="20260709"
export GITHUB_USERNAME="your-github-username"

bunx wrangler r2 bucket create "intar-dev-vm-image-registry-${RESET_SUFFIX}" --jurisdiction eu
bunx wrangler r2 bucket create "intar-dev-vm-run-artifacts-${RESET_SUFFIX}" --jurisdiction eu
bunx wrangler d1 create "intar-dev-app-${RESET_SUFFIX}" --jurisdiction eu
```

Copy the new D1 name and ID plus both new R2 bucket names into
`wrangler.jsonc`. Do not deploy while the D1 ID is still all zeroes or while
either R2 binding still names the previous generation. Bootstrap the new remote
database and approve the first administrator's normalized GitHub username:

```bash
bunx wrangler d1 execute DB --remote --file drizzle/0000_baseline.sql --config wrangler.jsonc
bunx wrangler d1 execute DB --remote --config wrangler.jsonc \
  --command "INSERT INTO access_allowlist (github_username, approved_by, approved_at) VALUES (lower('${GITHUB_USERNAME}'), NULL, cast(unixepoch('subsecond') * 1000 as integer)) ON CONFLICT(github_username) DO UPDATE SET approved_by = NULL, approved_at = excluded.approved_at;"

bun run build
```

Commit the new resource bindings, merge them to `main`, then manually dispatch
the `Website` workflow with `reset_generation_ready` confirmed. The `production`
environment deploys exactly the artifact built by that workflow.

After the reset Worker is live, manually dispatch the `Images` workflow from
`main` with `reset_generation_ready` confirmed. This deliberately uploads the
current source bundle into the new generation instead of relying on a push that
may have reached the previous Worker before the cutover.

Sign in once through GitHub so Better Auth creates the D1 user, then grant that
user the application admin role and verify both authorization records:

```bash
bunx wrangler d1 execute DB --remote --config wrangler.jsonc \
  --command "UPDATE user SET role = 'admin' WHERE username = lower('${GITHUB_USERNAME}');"
bunx wrangler d1 execute DB --remote --config wrangler.jsonc \
  --command "SELECT a.github_username, u.id, u.role FROM access_allowlist a LEFT JOIN user u ON u.username = a.github_username WHERE a.github_username = lower('${GITHUB_USERNAME}');"
```

Validate sign-in, an admin API, an agent connection, and new writes to both R2
buckets before retirement. Keep the old D1 and old R2 buckets intact until that
proof is complete; then export the old D1 if required, empty and delete both old
R2 buckets, delete the old D1, and delete the obsolete KV allowlist namespace.
No data is copied forward in this intentionally incompatible reset.

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
