#!/usr/bin/env bun

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CloudflareD1RestClient,
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
  readonly scenarioCounts: readonly [number, number, number];
}

/**
 * Rehearses the pending generated migrations on a disposable database.
 *
 * The baseline is the committed prefix production reports, built with the same
 * atomic applier production uses, and the seed writes the rows that must
 * survive. The pending set is then applied and the result is verified against
 * the full committed schema, so the rehearsal proves the real transition
 * rather than a schema-only reproduction.
 */
export async function runRehearsal(input: {
  client: D1WriteClient;
  appliedCount: number;
}): Promise<RehearsalEvidence> {
  const { client } = input;
  const baselineTags = await applyBaselineMigrations(client, input.appliedCount);
  await client.batch(rehearsalSeedStatements());
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
  const scenarioCounts = await client.batchRead?.([
    {
      sql: "SELECT count(*) AS count FROM runtime_executions WHERE domain_kind = 'scenario'",
    },
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
  return {
    schemaSha256: proof.schemaSha256,
    baselineTags,
    appliedTags: applied.appliedTags,
    appliedMigrationCount: proof.appliedMigrationCount,
    committedMigrationCount: proof.committedMigrationCount,
    foreignKeyViolations: proof.foreignKeyViolations,
    scenarioCounts: [1, 1, 1],
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
 * Rows that exercise the pending migrations on realistic data.
 *
 * The seed writes only tables that still exist at the baseline prefix: the
 * retired domain tables (provider connections and credentials, workshop
 * workspaces) were dropped by the removal migration, so a rehearsal that
 * started at a later prefix could not insert them. What must survive is the
 * scenario runtime data, and one scenario execution with its VM, artifact, and
 * a run row is the shape that proves it.
 */
export function rehearsalSeedStatements(): D1Statement[] {
  const sha = (character: string) => character.repeat(64);
  return [
    {
      sql: "INSERT INTO user (id, name, email) VALUES ('user-1', 'User', 'user@example.test')",
    },
    {
      sql: "INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Org', 'org', 1)",
    },
    {
      sql: "INSERT INTO agent_hosts (id, user_id, name) VALUES ('host-1', 'user-1', 'Host')",
    },
    {
      sql: "INSERT INTO scenario_runs (run_id, user_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown, objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, revealed_hints_json, solution_assisted, vm_count, state, state_rank, active_key, state_json, created_at, updated_at) VALUES ('run-1', 'user-1', 'host-1', 'broken-nginx', 'broken-nginx', 'Title', 'Tagline', 'Briefing', '[]', 'beginner', 30, '[]', '[]', 'Solution', '[]', 0, 1, 'provisioning', 1, 'user-1', '{}', 1, 1)",
    },
    {
      sql: "INSERT INTO runtime_executions (id, user_id, host_id, domain_kind, domain_id, generation, state) VALUES ('run-1', 'user-1', 'host-1', 'scenario', 'run-1', 1, 'provisioning')",
    },
    {
      sql: "INSERT INTO runtime_vms (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256, cpu_millis, memory_mib, disk_mib) VALUES ('runtime-vm-1', 'run-1', 'vm-1', 0, 'server', '{}', '" + sha("a") + "', 1000, 1024, 4096)",
    },
    {
      sql: "INSERT INTO runtime_artifacts (id, execution_id, runtime_vm_id, ordinal, kind, filename, content_type, size_bytes, sha256, r2_key, upload_status, uploaded_at) VALUES ('artifact-1', 'run-1', 'runtime-vm-1', 0, 'terminal_recording', 'recording.krec', 'application/octet-stream', 1, '" + sha("b") + "', 'runs/run-1/recording.krec', 'uploaded', 1)",
    },
  ];
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
