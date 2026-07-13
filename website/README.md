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

The jailer cutover is a coordinated break: scenario catalog manifests are V3,
the bridge envelope is V6, and its desired-state/resource/capacity/report
documents are V2. There is no V2-catalog or V5-bridge compatibility shim.
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
bun run db:bootstrap:local
bunx wrangler dev --config dist/server/wrangler.json --port 8788
```

`astro dev` automatically uses `wrangler.local.jsonc`. Its D1, R2, Durable
Object, and rate-limit bindings are simulated locally and it intentionally has
no production route or VPC service binding. Production checks and builds keep
using `wrangler.jsonc`. The bootstrap script deliberately uses the Wrangler
version bundled with the Cloudflare Vite plugin so its persisted SQLite state
stays compatible with the local workerd runtime.

`drizzle/*.sql` is an ordered migration stream. `bun run db:bootstrap:local`
applies every migration to a fresh local database in filename order. Existing
databases must apply only their first unapplied migration onward; for example,
the Cloud Hypervisor jailer rollout uses:

```bash
bun run db:migrate:remote -- --from 0001_host_cpu_reservations.sql
```

Migration files are one-shot and deliberately fail when reapplied. Apply the
remote migration before deploying code that uses its schema.

`0001_host_cpu_reservations.sql` is also the V6 bridge cutover boundary. It
refuses to run while any bridge client is connected, scenario placement is
enabled on an agent, a scenario run or image build is active, desired VM state
is anything other than an `absent` tombstone, or an actual report still
contains a VM/build. On success it bumps and replaces every drained V5 desired
document with an empty schema-3 document and removes old actual reports. Stop
every V5 agent and builder before applying it so neither can write an old
document back during the migration-to-deploy interval.

For the jailer rollout, enter maintenance and drain all old scenario VMs before
stopping the old agents. Install jailerd, jailer, the pinned Cloud Hypervisor
v53.0 runtime, and systemd units while agents remain stopped; apply the
reservation migration; deploy the V6 Worker; republish every scenario as V3;
then start only hosts that pass both agent doctor and the root-only jailerd
self-test. Validate `cpu = 0.125` and the eight-VM saturation case before
re-enabling starts. Existing unsandboxed VMs cannot be adopted.

Pull requests run the test/build and UI quality gates. A merge to `main` that
changes the website automatically builds that exact commit and deploys it
through the `Website production` workflow; do not deploy an ignored local
`dist/` artifact directly. The production workflow creates the deployable Astro
artifact but does not repeat the pull request quality gates. Treat `main` as
deploy-only: a direct website push bypasses those gates and deploys immediately.

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
bun run db:migrate:remote
bunx wrangler d1 execute DB --remote --config wrangler.jsonc \
  --command "INSERT INTO access_allowlist (github_username, approved_by, approved_at) VALUES (lower('${GITHUB_USERNAME}'), NULL, cast(unixepoch('subsecond') * 1000 as integer)) ON CONFLICT(github_username) DO UPDATE SET approved_by = NULL, approved_at = excluded.approved_at;"

bun run build
```

Commit the new resource bindings and open a pull request, but do not merge it
until the new D1 baseline and both rotated R2 bindings are ready. After the pull
request quality gates pass, merge it to `main`. The `Website production`
workflow builds the exact merged commit and deploys it automatically through
the `production` environment.

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
