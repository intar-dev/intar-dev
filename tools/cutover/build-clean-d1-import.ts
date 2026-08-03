#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export const CLEAN_D1_MIGRATION_NAME = "0000_clean_multicloud.sql";

const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

export function buildCleanD1Import(baseline: string): string {
  if (baseline.trim().length === 0) {
    throw new Error("the clean D1 baseline must not be empty");
  }
  if (baseline.includes("\0")) {
    throw new Error("the clean D1 baseline must not contain NUL bytes");
  }
  if (/\bd1_migrations\b/i.test(baseline)) {
    throw new Error(
      "the clean D1 baseline must not manage Wrangler's migration ledger",
    );
  }

  return [
    MIGRATION_TABLE_SQL,
    baseline.trimEnd(),
    `INSERT INTO "d1_migrations" (name) VALUES ('${CLEAN_D1_MIGRATION_NAME}');`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const [baselinePath, ...extraArguments] = process.argv.slice(2);
  if (!baselinePath || extraArguments.length > 0) {
    throw new Error("usage: build-clean-d1-import.ts <baseline.sql>");
  }
  if (basename(baselinePath) !== CLEAN_D1_MIGRATION_NAME) {
    throw new Error(
      `the clean D1 baseline must be named ${CLEAN_D1_MIGRATION_NAME}`,
    );
  }

  process.stdout.write(buildCleanD1Import(await readFile(baselinePath, "utf8")));
}

if (import.meta.main) await main();
