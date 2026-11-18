#!/usr/bin/env bun

// Rows production needs that no request creates, applied on every deploy
// after the schema is verified. Migrations carry only generated schema
// statements (apps/web/AGENTS.md), so such rows live in apps/web/seeds/*.sql.
//
// A seed is one statement that only ever adds a missing row: an INSERT that
// ends in ON CONFLICT DO NOTHING. Anything else is refused before D1 is
// touched, so a seed can run on every deploy and never changes a row.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareD1RestClient, type D1WriteClient } from "./d1-rest-client";

const seedsFolder = fileURLToPath(new URL("../../apps/web/seeds", import.meta.url));

export interface Seed {
  readonly name: string;
  readonly sql: string;
}

/** The statement of a seed file, or an error naming why it is not a seed. */
export function seedStatement(name: string, raw: string): string {
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;$/u, "");
  if (sql.includes(";")) throw new Error(`${name}: a seed is one statement`);
  if (!/^INSERT\s+INTO\s/iu.test(sql) || !/\sON\s+CONFLICT\s+DO\s+NOTHING$/iu.test(sql)) {
    throw new Error(`${name}: a seed is an INSERT that ends in ON CONFLICT DO NOTHING`);
  }
  return sql;
}

export function readSeeds(folder = seedsFolder): Seed[] {
  return readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({ name: file, sql: seedStatement(file, readFileSync(join(folder, file), "utf8")) }));
}

/** Applies every seed in one transaction; says how many rows each added. */
export async function applySeeds(
  client: D1WriteClient,
  seeds: readonly Seed[] = readSeeds(),
): Promise<Array<{ name: string; added: number | null }>> {
  if (seeds.length === 0) return [];
  const results = await client.batch(seeds.map(({ sql }) => ({ sql })));
  return seeds.map(({ name }, index) => ({ name, added: results[index]?.changes ?? null }));
}

if (import.meta.main) {
  try {
    const required = (name: string) => {
      const value = process.env[name]?.trim();
      if (!value) throw new Error(`${name} is required`);
      return value;
    };
    const databaseId = required("CLOUDFLARE_DATABASE_ID");
    const evidencePath = resolve(required("SEED_APPLY_EVIDENCE"));
    if (existsSync(evidencePath)) throw new Error(`evidence path already exists: ${evidencePath}`);
    const seeds = await applySeeds(new CloudflareD1RestClient({
      accountId: required("CLOUDFLARE_ACCOUNT_ID"),
      databaseId,
      token: process.env.CLOUDFLARE_D1_TOKEN?.trim() || required("CLOUDFLARE_API_TOKEN"),
    }));
    writeFileSync(evidencePath, `${JSON.stringify({ databaseId, seeds }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, databaseId, seeds }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
