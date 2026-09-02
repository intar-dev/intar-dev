#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareD1RestClient, type D1Statement } from "./d1-rest-client";
import { applyRemovalMigration } from "./apply-removal-migration";
import { verifyGeneratedD1Schema } from "./generated-d1-schema";
import { purgeRemovedRuntimeDomains } from "./purge-removed-runtime-domains";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = join(repositoryRoot, "apps/web");
const migrationsRoot = join(webRoot, "migrations");

if (import.meta.main) {
  const evidencePath = argumentValue("--evidence");
  if (existsSync(evidencePath)) {
    throw new Error(`evidence path already exists: ${evidencePath}`);
  }
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const token =
    process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
    requiredEnvironment("CLOUDFLARE_API_TOKEN");
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const runAttempt = requiredEnvironment("GITHUB_RUN_ATTEMPT");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "intar-d1-rehearsal-"));
  let databaseId: string | null = null;

  try {
    databaseId = await createDatabase({
      accountId,
      token,
      name: `intar-removal-rehearsal-${runId}-${runAttempt}`,
    });
    const client = new CloudflareD1RestClient({ accountId, databaseId, token });
    const baselineRoot = join(temporaryRoot, "baseline");
    prepareBaselineMigrations(baselineRoot);
    await migrate(databaseId, baselineRoot);
    await client.batch(rehearsalSeedStatements());
    await applyRemovalMigration(client);
    const cleanup = await purgeRemovedRuntimeDomains(client);
    const proof = await verifyGeneratedD1Schema(client, { expectation: "full" });
    const scenarioCounts = await client.batchRead?.([
      { sql: "SELECT count(*) AS count FROM runtime_executions WHERE domain_kind = 'scenario'" },
      { sql: "SELECT count(*) AS count FROM runtime_vms" },
      { sql: "SELECT count(*) AS count FROM runtime_artifacts" },
    ]);
    if (
      !scenarioCounts ||
      scenarioCounts.length !== 3 ||
      scenarioCounts.some((result) => result.rows[0]?.count !== 1)
    ) {
      throw new Error("disposable D1 rehearsal did not preserve scenario data");
    }
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          databaseId,
          schemaSha256: proof.schemaSha256,
          appliedMigrationCount: proof.appliedMigrationCount,
          committedMigrationCount: proof.committedMigrationCount,
          foreignKeyViolations: proof.foreignKeyViolations,
          cleanup,
          scenarioCounts: [1, 1, 1],
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } finally {
    if (databaseId) await deleteDatabase({ accountId, databaseId, token });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function rehearsalSeedStatements(): D1Statement[] {
  return [
    { sql: "INSERT INTO user (id, name, email) VALUES ('user-1', 'User', 'user@example.test')" },
    { sql: "INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Org', 'org', 1)" },
    { sql: "INSERT INTO agent_hosts (id, user_id, name) VALUES ('host-1', 'user-1', 'Host')" },
    {
      sql: "INSERT INTO runtime_executions (id, user_id, host_id, domain_kind, domain_id, generation, state) VALUES ('execution-1', 'user-1', 'host-1', 'scenario', 'run-1', 1, 'archived'), ('execution-removed', 'user-1', 'host-1', 'workshop', 'workspace-1', 1, 'archived')",
    },
    {
      sql: `INSERT INTO runtime_vms (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256, cpu_millis, memory_mib, disk_mib) VALUES ('runtime-vm-1', 'execution-1', 'vm-1', 0, 'server', '{}', '${"a".repeat(64)}', 1000, 1024, 4096), ('runtime-vm-removed', 'execution-removed', 'vm-removed', 0, 'removed', '{}', '${"d".repeat(64)}', 1000, 1024, 4096)`,
    },
    {
      sql: `INSERT INTO runtime_artifacts (id, execution_id, runtime_vm_id, ordinal, kind, filename, content_type, size_bytes, sha256, r2_key, upload_status, uploaded_at) VALUES ('artifact-1', 'execution-1', 'runtime-vm-1', 0, 'terminal_recording', 'recording.krec', 'application/octet-stream', 1, '${"b".repeat(64)}', 'runs/run-1/recording.krec', 'uploaded', 1), ('artifact-removed', 'execution-removed', 'runtime-vm-removed', 0, 'terminal_recording', 'removed.krec', 'application/octet-stream', 1, '${"e".repeat(64)}', 'runs/removed/recording.krec', 'uploaded', 1)`,
    },
    {
      sql: "INSERT INTO provider_connections (id, organization_id, provider_kind, display_name, external_project_id, project_fingerprint, created_by) VALUES ('connection-1', 'org-1', 'hetzner_cloud', 'Provider', 'project-1', 'fingerprint', 'user-1')",
    },
    {
      sql: `INSERT INTO provider_credential_versions (id, connection_id, version, authority, algorithm, kek_version, aad_sha256, encrypted_payload_b64, payload_iv_b64, wrapped_dek_b64, dek_iv_b64, credential_fingerprint, created_by, activated_at) VALUES ('credential-1', 'connection-1', 1, 'active', 'AES-256-GCM', 'v1', '${"c".repeat(64)}', 'payload', 'iv', 'dek', 'dek-iv', 'fingerprint', 'user-1', 1)`,
    },
  ];
}

function prepareBaselineMigrations(destination: string): void {
  cpSync(migrationsRoot, destination, { recursive: true });
  const journalPath = join(destination, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const removal = journal.entries.at(-1);
  if (!removal || removal.idx !== 13) {
    throw new Error("expected removal migration at index 13");
  }
  journal.entries.pop();
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  unlinkSync(join(destination, `${removal.tag}.sql`));
  const snapshotPath = join(destination, "meta/0013_snapshot.json");
  if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
}

async function migrate(databaseId: string, migrationsOut: string): Promise<void> {
  const process = Bun.spawn(
    ["bun", "run", "db:migrate:production"],
    {
      cwd: webRoot,
      env: {
        ...globalThis.process.env,
        CLOUDFLARE_DATABASE_ID: databaseId,
        DRIZZLE_D1_HTTP: "1",
        DRIZZLE_MIGRATIONS_OUT: migrationsOut,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await process.exited) !== 0) {
    throw new Error("disposable D1 migration failed");
  }
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

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return resolve(value);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
