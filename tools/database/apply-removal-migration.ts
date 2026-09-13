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

/**
 * The removal migration is pinned by index and tag. Later migrations append
 * after it, so selecting the newest journal entry would read the wrong SQL
 * file: the index is the identity, not the position in the journal.
 */
export const REMOVAL_MIGRATION_IDX = 13;
export const REMOVAL_MIGRATION_TAG = "0013_amused_kinsey_walden";

interface RemovalMigrationEntry {
  idx: number;
  tag: string;
  when: number;
}

/**
 * Selects the removal migration from the committed journal by exact index and
 * tag, and refuses a journal that does not contain exactly one such entry.
 */
export function removalMigrationEntry(
  journal: {
    entries: RemovalMigrationEntry[];
  } = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: RemovalMigrationEntry[];
  },
): RemovalMigrationEntry {
  const matches = journal.entries.filter(
    (entry) =>
      entry.idx === REMOVAL_MIGRATION_IDX &&
      entry.tag === REMOVAL_MIGRATION_TAG,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${REMOVAL_MIGRATION_TAG} entry at index ${REMOVAL_MIGRATION_IDX}, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

export function removalMigrationBatch(): D1Statement[] {
  const migration = removalMigrationEntry();
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
  // Explicit control: the boundary is the removal migration's own index, not
  // the length of the journal. Later migrations may be appended at any time.
  if (before.appliedMigrationCount !== REMOVAL_MIGRATION_IDX) {
    throw new Error(
      `D1 has ${before.appliedMigrationCount} applied migrations; the removal migration applies from exactly ${REMOVAL_MIGRATION_IDX}`,
    );
  }
  if (before.committedMigrationCount < REMOVAL_MIGRATION_IDX + 1) {
    throw new Error("the committed migration stream does not contain the removal migration");
  }
  const batch = removalMigrationBatch();
  await client.batch(batch);
  // The workflow covers the removal transition only. Verify the observed
  // ledger prefix, so a later appended migration does not fail the apply.
  const after = await verifyGeneratedD1Schema(client, {
    expectation: "observed-ledger-prefix",
  });
  if (after.appliedMigrationCount !== REMOVAL_MIGRATION_IDX + 1) {
    throw new Error(
      `D1 has ${after.appliedMigrationCount} applied migrations after the removal migration`,
    );
  }
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
