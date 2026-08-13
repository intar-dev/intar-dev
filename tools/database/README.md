# Production D1 rebaseline

The production copy tool moves an allowlisted subset of durable data from the
legacy D1 database into a fresh database created from the generated Drizzle
baseline. It never creates, alters, or drops schema objects and never writes to
the source database.

The target must first be migrated with Drizzle Kit:

```sh
DRIZZLE_D1_HTTP=1 \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_DATABASE_ID=<new-database-id> \
CLOUDFLARE_D1_TOKEN=<token> \
bun run --cwd apps/web db:migrate:production
```

Run the same source and target through a read-only preflight and then the copy:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_D1_TOKEN=<token> \
bun tools/database/copy-production-d1.ts \
  --source-database-id <old-database-id> \
  --target-database-id <new-database-id> \
  --dry-run \
  --evidence <new-database-id>-preflight.json

CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_D1_TOKEN=<token> \
bun tools/database/copy-production-d1.ts \
  --source-database-id <old-database-id> \
  --target-database-id <new-database-id> \
  --apply \
  --evidence <new-database-id>-copy.json
```

`CLOUDFLARE_API_TOKEN` is accepted when `CLOUDFLARE_D1_TOKEN` is unset. The
token requires D1 read access to the source and D1 write access to the target.

Both modes require an empty target with the exact `0000_init` Drizzle marker,
tables, columns, foreign keys, and indexes, plus zero triggers, views, and
foreign-key violations. Both fail if the source still has connected hosts,
capabilities, locks, reservations, open terminals, or any nonterminal
scenario, workshop, build, runtime, provider, publication, or cleanup work.
The caller must put the old Worker into maintenance and drain it before running
the tool; the tool cannot itself stop an already-open Worker, Durable Object,
or agent socket.

The manifest is exhaustive: every generated application table is explicitly
copied or excluded. A new table makes the tests and runtime preflight fail
until a policy is added. Copied rows use bounded keyset pagination and
parameterized bounded inserts. Before and after the copy, the tool computes
canonical per-table counts and SHA-256 hashes. A source change during the copy,
a target mismatch, or a foreign-key failure prevents success evidence.

Capability handling is deliberately conservative:

- Better Auth user, organization, member, and provider/account identities are
  retained, but account access, refresh, ID, password, expiry, and scope fields
  are cleared.
- Sessions, verification codes, OAuth clients/tokens/consent/assertions,
  signing keys, SSH/access keys, bootstrap tokens, route intents, guest
  credentials, upload grants, locks, reservations, and observed/desired live
  state are not copied. Signing keys rotate and users authenticate again.
- Leased beta invites return to `pending` with a new version. Registry tokens
  must be revoked before the copy and their stored hashes are replaced.
- Host registrations remain, but are normalized to disconnected with no
  active session. Runtime VM terminal connection credentials are cleared.
- Encrypted provider credential versions are retained as durable provider
  configuration because the replacement Worker keeps the same KEK secrets;
  live provider work, resources, and reconciliation state must be empty.

The copy is intentionally non-resumable. A failed apply can leave a partially
populated target. Do not rerun it against that target: retain the old database,
discard the new target, create and Drizzle-migrate another fresh database, and
repeat the preflight and apply. Never delete the old database during cutover.
