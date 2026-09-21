#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The web app owns the drizzle-orm dependency, and tools/ has no package of
// its own, so the installed reader is imported from its install location the
// same way the repository tests import the same library.
import { readMigrationFiles } from "../../apps/web/node_modules/drizzle-orm/migrator.js";
import {
  CloudflareD1RestClient,
  type D1Statement,
  type D1WriteClient,
} from "./d1-rest-client";
import { verifyGeneratedD1Schema } from "./generated-d1-schema";
import { HOST_REFERENCE_TABLES, preserveHostReferences } from "./preserve-host-references";

const migrationsFolder = fileURLToPath(
  new URL("../../apps/web/migrations", import.meta.url),
);

/** One committed generated migration that D1 has not applied yet. */
export interface PendingGeneratedMigration {
  readonly tag: string;
  readonly hash: string;
  readonly folderMillis: number;
  readonly statements: readonly string[];
}

export interface GeneratedMigrationApplyEvidence {
  readonly appliedMigrationCount: number;
  readonly committedMigrationCount: number;
  readonly appliedTags: readonly string[];
  readonly statementCount: number;
  readonly schemaSha256: string;
  readonly foreignKeyViolations: number;
}

/**
 * Every committed generated migration D1 has not applied yet, in journal order.
 *
 * The committed stream, its statement split, and its ledger hash come from the
 * installed Drizzle reader (readMigrationFiles), so this tool never reimplements
 * how a generated migration is parsed or recorded.
 *
 * The observed ledger is proven to be an exact prefix of that stream first, so
 * a database that diverged from the repository is refused instead of having
 * migrations skipped or replayed.
 *
 * Why the drizzle-kit CLI is not used here: its d1-http path calls the remote
 * callback once per statement, so a migration that fails halfway leaves the
 * schema partly applied with no marker. Each migration here travels as one D1
 * batch, and D1 runs a batch as one transaction, so a migration and its marker
 * land together or not at all.
 */
export async function planGeneratedMigrations(
  client: D1WriteClient,
): Promise<{
  appliedMigrationCount: number;
  committedMigrationCount: number;
  pending: readonly PendingGeneratedMigration[];
}> {
  const observed = await verifyGeneratedD1Schema(client, {
    expectation: "observed-ledger-prefix",
  });
  const migrations = readMigrationFiles({ migrationsFolder });
  // One guard before any write: the migrations read from this checkout must
  // be exactly the stream the verifier matched the observed ledger against,
  // so a checkout that disagrees with the committed count is refused here
  // instead of having the pending set computed from a different stream.
  if (migrations.length !== observed.committedMigrationCount) {
    throw new Error(
      `this checkout holds ${migrations.length} committed migrations but the committed stream declares ${observed.committedMigrationCount}`,
    );
  }
  const lastObserved = observed.migrations.at(-1)?.createdAt ?? 0;
  const tagsByWhen = journalTagsByWhen();
  const pending = migrations
    .filter((migration) => migration.folderMillis > lastObserved)
    .map((migration) => ({
      tag: tagsByWhen.get(migration.folderMillis) ?? String(migration.folderMillis),
      hash: migration.hash,
      folderMillis: migration.folderMillis,
      statements: migrationStatements(migration.sql),
    }));
  return {
    appliedMigrationCount: observed.appliedMigrationCount,
    committedMigrationCount: migrations.length,
    pending,
  };
}

/**
 * The statements of one generated migration, without blank entries. The
 * migrator keeps the raw split, and the D1 REST endpoint needs the blank
 * separators removed before they are sent.
 */
export function migrationStatements(sql: readonly string[]): string[] {
  return sql.map((statement) => statement.trim()).filter(Boolean);
}

/** The D1 batch for one generated migration: its statements and its marker. */
export function generatedMigrationBatch(
  migration: PendingGeneratedMigration,
): D1Statement[] {
  if (migration.statements.length === 0) {
    throw new Error(
      "generated migration " + migration.tag + " has no statements",
    );
  }
  return [
    ...(migration.statements.includes("DROP TABLE `agent_hosts`;")
      ? preserveHostReferences(migration.statements, migration.tag === "0023_fuzzy_mastermind"
        ? HOST_REFERENCE_TABLES : [...HOST_REFERENCE_TABLES, "personal_image_preparations"])
      : migration.statements.map((sql) => ({ sql }))),
    {
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      params: [migration.hash, migration.folderMillis],
    },
  ];
}

/**
 * Applies exactly the first count committed generated migrations, one atomic
 * batch each. A disposable rehearsal uses it to build the prefix that
 * production reports, through the same applier production itself uses.
 */
export async function applyGeneratedPrefix(
  client: D1WriteClient,
  count: number,
): Promise<readonly string[]> {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (!Number.isSafeInteger(count) || count <= 0 || count > migrations.length) {
    throw new Error(
      "the applied prefix must be a positive count within the committed stream",
    );
  }
  // The pinned migrator creates the ledger table before it applies anything.
  // A fresh disposable database needs the same first step.
  await client.batch([
    {
      sql:
        'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n\tid SERIAL PRIMARY KEY,\n\thash text NOT NULL,\n\tcreated_at numeric\n)',
    },
  ]);
  const tagsByWhen = journalTagsByWhen();
  const applied: string[] = [];
  for (const migration of migrations.slice(0, count)) {
    const pending: PendingGeneratedMigration = {
      tag: tagsByWhen.get(migration.folderMillis) ?? String(migration.folderMillis),
      hash: migration.hash,
      folderMillis: migration.folderMillis,
      statements: migrationStatements(migration.sql),
    };
    await client.batch(generatedMigrationBatch(pending));
    applied.push(pending.tag);
  }
  return applied;
}

export async function applyGeneratedMigrations(
  client: D1WriteClient,
): Promise<GeneratedMigrationApplyEvidence> {
  const plan = await planGeneratedMigrations(client);
  let statementCount = 0;
  for (const migration of plan.pending) {
    statementCount += migration.statements.length;
    await client.batch(generatedMigrationBatch(migration));
  }
  const after = await verifyGeneratedD1Schema(client, { expectation: "full" });
  return {
    appliedMigrationCount: after.appliedMigrationCount,
    committedMigrationCount: after.committedMigrationCount,
    appliedTags: plan.pending.map((migration) => migration.tag),
    statementCount,
    schemaSha256: after.schemaSha256,
    foreignKeyViolations: after.foreignKeyViolations,
  };
}

/** Migration tags by their journal timestamp, for readable evidence only. */
function journalTagsByWhen(): Map<number, string> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  return new Map(journal.entries.map((entry) => [entry.when, entry.tag]));
}

if (import.meta.main) {
  try {
    const databaseId = requiredEnvironment("CLOUDFLARE_DATABASE_ID");
    const evidencePath = resolve(
      requiredEnvironment("MIGRATION_APPLY_EVIDENCE"),
    );
    if (existsSync(evidencePath)) {
      throw new Error("evidence path already exists: " + evidencePath);
    }
    const client = new CloudflareD1RestClient({
      accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
      databaseId,
      token:
        process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
        requiredEnvironment("CLOUDFLARE_API_TOKEN"),
    });
    const evidence = await applyGeneratedMigrations(client);
    writeFileSync(
      evidencePath,
      JSON.stringify({ databaseId, ...evidence }, null, 2) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}
