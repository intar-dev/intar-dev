#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CloudflareD1RestClient,
  type D1Statement,
  type D1WriteClient,
} from "./d1-rest-client";
import { verifyGeneratedD1Schema } from "./generated-d1-schema";

const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const journalPath = `${webRoot}migrations/meta/_journal.json`;

export function removalMigrationBatch(): D1Statement[] {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const migration = journal.entries.at(-1);
  if (!migration || migration.idx !== 13) {
    throw new Error("expected removal migration at index 13");
  }
  const sql = readFileSync(`${webRoot}migrations/${migration.tag}.sql`, "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => ({ sql: statement }));
  return [
    ...statements,
    {
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      params: [
        createHash("sha256").update(sql).digest("hex"),
        migration.when,
      ],
    },
  ];
}

export async function applyRemovalMigration(client: D1WriteClient) {
  const before = await verifyGeneratedD1Schema(client, {
    expectation: "observed-ledger-prefix",
  });
  if (
    before.appliedMigrationCount !== 13 ||
    before.committedMigrationCount !== 14
  ) {
    throw new Error("D1 is not at the expected removal migration boundary");
  }
  const batch = removalMigrationBatch();
  await client.batch(batch);
  const after = await verifyGeneratedD1Schema(client, { expectation: "full" });
  return {
    statementCount: batch.length - 1,
    appliedMigrationCount: after.appliedMigrationCount,
    committedMigrationCount: after.committedMigrationCount,
    schemaSha256: after.schemaSha256,
    foreignKeyViolations: after.foreignKeyViolations,
  };
}

if (import.meta.main) {
  try {
    const databaseId = requiredEnvironment("CLOUDFLARE_DATABASE_ID");
    const evidencePath = resolve(requiredEnvironment("MIGRATION_APPLY_EVIDENCE"));
    if (existsSync(evidencePath)) {
      throw new Error(`evidence path already exists: ${evidencePath}`);
    }
    const client = new CloudflareD1RestClient({
      accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
      databaseId,
      token:
        process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
        requiredEnvironment("CLOUDFLARE_API_TOKEN"),
    });
    const evidence = await applyRemovalMigration(client);
    writeFileSync(
      evidencePath,
      `${JSON.stringify({ databaseId, ...evidence }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
