#!/usr/bin/env bun

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CloudflareD1RestClient,
  type D1ReadClient,
  type D1Statement,
  type D1WriteClient,
} from "./d1-rest-client";
import {
  applyGeneratedMigrations,
  applyGeneratedPrefix,
} from "./apply-generated-migrations";
import { verifyGeneratedD1Schema } from "./generated-d1-schema";

export interface RehearsalEvidence {
  readonly schemaSha256: string;
  readonly baselineTags: readonly string[];
  readonly appliedTags: readonly string[];
  readonly appliedMigrationCount: number;
  readonly committedMigrationCount: number;
  readonly foreignKeyViolations: number;
  /** Tables the pending migrations dropped, by name. */
  readonly droppedTables: readonly string[];
  /** Tables that survived with every row and their schema unchanged. */
  readonly preservedTables: number;
  readonly preservedRows: number;
}

/** The one table the pending migrations may rebuild; it is empty after the wipe. */
export const REBUILT_TABLES: readonly string[] = ["runtime_vms"];

/**
 * Rehearses the pending generated migrations on a disposable database.
 *
 * The baseline is the committed prefix production reports, built with the same
 * atomic applier production uses, and the seed writes rows in the shape of
 * that baseline after the scenario wipe. The pending set is then applied, the
 * result is verified against the full committed schema, and every table that
 * survives must hold exactly the rows it held before, quoted value for quoted
 * value, under an unchanged definition.
 */
export async function runRehearsal(input: {
  client: D1WriteClient;
  appliedCount: number;
}): Promise<RehearsalEvidence> {
  const { client } = input;
  const baselineTags = await applyBaselineMigrations(client, input.appliedCount);
  await client.batch(rehearsalSeedStatements());
  const before = await snapshotTables(client);
  const applied = await applyGeneratedMigrations(client);
  if (applied.appliedTags.length === 0) {
    throw new Error("the rehearsal applied no pending migration");
  }
  const proof = await verifyGeneratedD1Schema(client, { expectation: "full" });
  if (proof.appliedMigrationCount !== proof.committedMigrationCount) {
    throw new Error(
      `rehearsal applied ${proof.appliedMigrationCount} of ${proof.committedMigrationCount} committed migrations`,
    );
  }
  const after = await snapshotTables(client);
  const preserved = comparePreservedTables(before, after);
  return {
    schemaSha256: proof.schemaSha256,
    baselineTags,
    appliedTags: applied.appliedTags,
    appliedMigrationCount: proof.appliedMigrationCount,
    committedMigrationCount: proof.committedMigrationCount,
    foreignKeyViolations: proof.foreignKeyViolations,
    ...preserved,
  };
}

export interface TableSnapshot {
  readonly sql: string;
  /** Every row as its columns' SQL `quote()` text, sorted. */
  readonly rows: readonly string[];
}

/** Each application table's definition and rows, by name. */
export async function snapshotTables(
  client: D1ReadClient,
): Promise<ReadonlyMap<string, TableSnapshot>> {
  const tables = await client.query(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> '_cf_KV' ORDER BY name",
  );
  const snapshot = new Map<string, TableSnapshot>();
  for (const table of tables.rows) {
    const name = String(table.name);
    const columns = await client.query(
      "SELECT name FROM pragma_table_info(?1) ORDER BY cid",
      [name],
    );
    const quoted = columns.rows
      .map((column) => `quote("${String(column.name).replaceAll('"', '""')}")`)
      .join(" || ',' || ");
    const rows = await client.query(
      `SELECT ${quoted} AS row FROM "${name.replaceAll('"', '""')}"`,
    );
    snapshot.set(name, {
      sql: String(table.sql),
      rows: rows.rows.map((row) => String(row.row)).sort(),
    });
  }
  return snapshot;
}

/**
 * Every table present after the migrations must hold the rows it held before;
 * every one but a rebuilt table must also keep its definition. A table that
 * appears only afterwards is refused: the removal adds none.
 */
export function comparePreservedTables(
  before: ReadonlyMap<string, TableSnapshot>,
  after: ReadonlyMap<string, TableSnapshot>,
): Pick<RehearsalEvidence, "droppedTables" | "preservedTables" | "preservedRows"> {
  let preservedRows = 0;
  for (const [name, table] of after) {
    const earlier = before.get(name);
    if (!earlier) throw new Error(`the migrations added the table ${name}`);
    if (!REBUILT_TABLES.includes(name) && earlier.sql !== table.sql) {
      throw new Error(`the migrations changed the definition of ${name}`);
    }
    if (JSON.stringify(earlier.rows) !== JSON.stringify(table.rows)) {
      throw new Error(`the migrations changed the rows of ${name}`);
    }
    preservedRows += table.rows.length;
  }
  return {
    droppedTables: [...before.keys()].filter((name) => !after.has(name)),
    preservedTables: after.size,
    preservedRows,
  };
}

if (import.meta.main) {
  const evidencePath = argumentValue("--evidence");
  const appliedCount = Number(argumentValue("--applied", false));
  if (existsSync(evidencePath)) {
    throw new Error(`evidence path already exists: ${evidencePath}`);
  }
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const token =
    process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
    requiredEnvironment("CLOUDFLARE_API_TOKEN");
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const runAttempt = requiredEnvironment("GITHUB_RUN_ATTEMPT");
  let databaseId: string | null = null;
  try {
    databaseId = await createDatabase({
      accountId,
      token,
      name: `intar-pending-migration-rehearsal-${runId}-${runAttempt}`,
    });
    const client = new CloudflareD1RestClient({
      accountId,
      databaseId,
      token,
    });
    const evidence = await runRehearsal({ client, appliedCount });
    writeFileSync(
      evidencePath,
      `${JSON.stringify({ databaseId, ...evidence }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } finally {
    if (databaseId) await deleteDatabase({ accountId, databaseId, token });
  }
}

/**
 * Rows in the shape of the production baseline after the scenario wipe: no
 * run or execution is left, while accounts, organizations, hosts, enrollment,
 * gates, registry state, sources, catalogs and the revision model's scenarios
 * remain. The retired scenario and build tables hold rows too, so the drop is
 * rehearsed on data rather than on empty tables.
 */
export function rehearsalSeedStatements(): D1Statement[] {
  const digest = (character: string) => "sha256:" + character.repeat(64);
  return [
    "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('user-1', 'User', 'user@example.test', 1, 2)",
    "INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('session-1', 9, 'token-1', 1, 2, 'user-1')",
    "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('account-1', '42', 'github', 'user-1', 1, 2)",
    "INSERT INTO verification (id, identifier, value, expires_at) VALUES ('verification-1', 'email', 'code', 9)",
    "INSERT INTO user_ssh_keys (id, user_id, key_type, public_key_openssh, fingerprint_sha256) VALUES ('ssh-key-1', 'user-1', 'ssh-ed25519', 'ssh-ed25519 AAAA', 'SHA256:abc')",
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Org', 'org', 1)",
    "INSERT INTO organization_entitlements (organization_id) VALUES ('org-1')",
    "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('member-1', 'org-1', 'user-1', 'owner', 1)",
    "INSERT INTO invitation (id, organization_id, email, role, status, expires_at, inviter_id) VALUES ('invitation-1', 'org-1', 'invitee@example.test', 'member', 'pending', 9, 'user-1')",
    "INSERT INTO sso_provider (id, issuer, domain, user_id, provider_id, organization_id) VALUES ('sso-1', 'https://issuer.example.test', 'example.test', 'user-1', 'provider-1', 'org-1')",
    "INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('oauth-client-1', 'client-1', '[]')",
    "INSERT INTO oauth_resource (id, identifier, name) VALUES ('oauth-resource-1', 'https://api.example.test', 'API')",
    "INSERT INTO oauth_consent (id, client_id, user_id, scopes) VALUES ('consent-1', 'client-1', 'user-1', 'openid')",
    "INSERT INTO signup_settings (id, signup_limit, version, updated_at) VALUES (1, 10, 1, 1)",
    "INSERT INTO signup_reservations (user_id, created_at, expires_at) VALUES ('user-1', 1, 9)",
    "INSERT INTO support_topics (id, title, type, body, status, author_id) VALUES ('topic-1', 'Topic', 'help', 'Body', 'open', 'user-1')",
    "INSERT INTO support_comments (id, topic_id, body, author_id) VALUES ('comment-1', 'topic-1', 'Comment', 'user-1')",
    "INSERT INTO access_events (id, event_type) VALUES ('access-event-1', 'granted')",
    "INSERT INTO access_revocations (user_id, revocation_id, revoked_by, reason, revoked_at) VALUES ('user-1', 'revocation-1', 'user-1', 'test', 1)",
    "INSERT INTO agent_hosts (id, user_id, name) VALUES ('host-1', 'user-1', 'Host')",
    "INSERT INTO agent_bootstrap_tokens (id, host_id, token_hash) VALUES ('bootstrap-1', 'host-1', 'hash-1')",
    "INSERT INTO host_enrollments (token_hash, host_id, user_id, name, scope, role, expires_at) VALUES ('enrollment-hash-1', 'host-1', 'user-1', 'Host', 'personal', 'agent', 9)",
    "INSERT INTO host_desired_state (host_id, version, doc_json) VALUES ('host-1', 3, '{\"vms\":[]}')",
    "INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json) VALUES ('host-1', 3, 1, '{\"vms\":[]}')",
    "INSERT INTO runtime_operation_gates (key, state) VALUES ('image_cutover', 'wiped')",
    "INSERT INTO image_registry_admission (key, protocol_version) VALUES ('registry', 1)",
    "INSERT INTO image_registry_gc_runs (id, owner, sweep_token, started_at, heartbeat_at) VALUES ('gc-1', 'oci-registry-sweep', 'sweep-1', 1, 2)",
    `INSERT INTO registry_manifests (digest, media_type, artifact_type, size) VALUES ('${digest("a")}', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.intar.machine.v1', 10)`,
    `INSERT INTO registry_manifest_blobs (manifest_digest, blob_digest) VALUES ('${digest("a")}', '${digest("b")}')`,
    "INSERT INTO scenario_sources (scope_key, github_installation_id, github_repository_id, github_repository, default_branch) VALUES ('public', 1, 2, 'owner/scenarios', 'main')",
    "INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, state) VALUES ('commit-1', 'public', 'deploy', 'abc', 'rev-1', 'push', 'live')",
    "INSERT INTO course_catalogs (scope_key, catalog_json, source_revision) VALUES ('public', '{\"version\":2,\"courses\":[]}', 'rev-1')",
    "INSERT INTO bundles (rev, scope_key, compiler_version, r2_key) VALUES ('rev-1', 'public', '1.0.0', 'bundles/rev-1.json.gz')",
    "INSERT INTO scenarios (id, namespace, slug, scope_key, enabled, play) VALUES ('intar/nginx', 'intar', 'nginx', 'public', 1, 0)",
    "INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state) VALUES ('intar/nginx', 'rev-1', 3, '{}', 'verified')",
    "INSERT INTO machine_builds (build_key, image_format, bundle_rev, state) VALUES ('" + digest("c") + "', 'raw', 'rev-1', 'succeeded')",
    "INSERT INTO image_build_bundles (rev, r2_key, meta_json) VALUES ('legacy-rev', 'legacy/bundle.tar', '{}')",
    "INSERT INTO image_builds (id, scenario_id, arch, rev, content_hash) VALUES ('legacy-build', 'legacy-scenario', 'x86_64', 'legacy-rev', 'hash')",
    "INSERT INTO vm_scenarios (scenario_id, title, description, difficulty, estimated_minutes, tags_json, briefing_markdown, solution_markdown, hints_json) VALUES ('legacy-scenario', 'Legacy', 'Retired', 'easy', 10, '[]', '', '', '[]')",
  ].map((sql) => ({ sql }));
}

/**
 * Applies the committed generated prefix to a disposable database with the
 * same atomic applier production uses: one D1 batch per generated migration,
 * its standard ledger marker included.
 *
 * The drizzle-kit CLI is not used for the baseline. Its d1-http path sends one
 * statement per request, so the 0013 foreign-key PRAGMA wrapper and its DROP
 * statements would not share one transaction, which is the exact failure the
 * D1 foreign-key exception exists to avoid.
 */
export async function applyBaselineMigrations(
  client: D1WriteClient,
  appliedCount: number,
): Promise<readonly string[]> {
  return applyGeneratedPrefix(client, appliedCount);
}


async function createDatabase(input: {
  accountId: string;
  token: string;
  name: string;
}): Promise<string> {
  const payload = await cloudflareRequest(input, "", {
    method: "POST",
    body: JSON.stringify({ name: input.name, primary_location_hint: "weur" }),
  });
  const result = payload.result as { uuid?: unknown } | undefined;
  if (typeof result?.uuid !== "string") {
    throw new Error("Cloudflare did not return a disposable D1 database ID");
  }
  return result.uuid;
}

async function deleteDatabase(input: {
  accountId: string;
  databaseId: string;
  token: string;
}): Promise<void> {
  await cloudflareRequest(input, `/${input.databaseId}`, { method: "DELETE" });
}

async function cloudflareRequest(
  input: { accountId: string; token: string },
  suffix: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/d1/database${suffix}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload.success !== true) {
    throw new Error(`Cloudflare D1 database request failed (${response.status})`);
  }
  return payload;
}

function argumentValue(name: string, path = true): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return path ? resolve(value) : value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
