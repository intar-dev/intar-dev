#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CloudflareD1RestClient,
  type D1ReadClient,
  type D1Statement,
  type D1WriteClient,
} from "../database/d1-rest-client";

interface DrizzleSnapshot {
  tables: Record<string, unknown>;
}

export interface D1BatchRollbackEvidence {
  version: 1;
  status: "rollback_proven";
  accountId: string;
  databaseId: string;
  probeTable: "user";
  probeId: string;
  batchRequestRejected: true;
  probeRowsAfterFailure: 0;
  applicationRowsBefore: 0;
  applicationRowsAfter: 0;
  applicationTableCount: number;
}

if (import.meta.main) {
  try {
    const [databaseId, evidencePath] = process.argv.slice(2);
    if (!databaseId || !evidencePath || process.argv.length !== 4) {
      throw new Error(
        "usage: probe-d1-batch-rollback.ts <database-id> <evidence.json>",
      );
    }
    if (!uuid(databaseId)) throw new Error("database ID must be a lowercase UUID");
    const resolvedEvidence = resolve(evidencePath);
    if (existsSync(resolvedEvidence)) {
      throw new Error(`evidence path already exists: ${resolvedEvidence}`);
    }
    const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
    const token =
      process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
      requiredEnvironment("CLOUDFLARE_API_TOKEN");
    const runId = requiredEnvironment("GITHUB_RUN_ID");
    if (!/^\d+$/u.test(runId)) throw new Error("GITHUB_RUN_ID must be numeric");

    const client = new CloudflareD1RestClient({
      accountId,
      databaseId,
      token,
    });
    const evidence = await proveD1BatchRollback(client, {
      accountId,
      databaseId,
      probeId: `__d1_batch_rollback_probe_${runId}`,
      tableNames: committedTableNames(),
    });
    writeFileSync(resolvedEvidence, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify({ ok: true, ...evidence }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function proveD1BatchRollback(
  client: D1WriteClient,
  input: {
    accountId: string;
    databaseId: string;
    probeId: string;
    tableNames: readonly string[];
  },
): Promise<D1BatchRollbackEvidence> {
  if (!input.tableNames.includes("user")) {
    throw new Error('generated Drizzle manifest must contain the "user" table');
  }
  const applicationRowsBefore = await countApplicationRows(
    client,
    input.tableNames,
  );
  if (applicationRowsBefore !== 0) {
    throw new Error(
      `fresh D1 contains ${applicationRowsBefore} application rows before rollback probe`,
    );
  }

  const insert = {
    sql: 'INSERT INTO "user" ("id", "name", "email") VALUES (?1, ?2, ?3)',
    params: [
      input.probeId,
      "D1 batch rollback probe",
      `${input.probeId}@invalid.example`,
    ],
  } as const;
  let batchRequestRejected = false;
  try {
    await client.batch([insert, insert]);
  } catch {
    batchRequestRejected = true;
  }
  if (!batchRequestRejected) {
    throw new Error("deliberately failing D1 REST batch was accepted");
  }

  const probeRowsAfterFailure = await scalarCount(
    client,
    'SELECT COUNT(*) AS count FROM "user" WHERE "id" = ?1',
    [input.probeId],
  );
  if (probeRowsAfterFailure !== 0) {
    throw new Error(
      "D1 REST batch retained the first statement after the second statement failed",
    );
  }
  const applicationRowsAfter = await countApplicationRows(
    client,
    input.tableNames,
  );
  if (applicationRowsAfter !== 0) {
    throw new Error(
      `fresh D1 contains ${applicationRowsAfter} application rows after rollback probe`,
    );
  }

  return {
    version: 1,
    status: "rollback_proven",
    accountId: input.accountId,
    databaseId: input.databaseId,
    probeTable: "user",
    probeId: input.probeId,
    batchRequestRejected: true,
    probeRowsAfterFailure: 0,
    applicationRowsBefore: 0,
    applicationRowsAfter: 0,
    applicationTableCount: input.tableNames.length,
  };
}

function committedTableNames(): string[] {
  const snapshotPath = resolve(
    import.meta.dirname,
    "../../apps/web/migrations/meta/0000_snapshot.json",
  );
  const snapshot = JSON.parse(
    readFileSync(snapshotPath, "utf8"),
  ) as DrizzleSnapshot;
  return Object.keys(snapshot.tables).sort();
}

async function countApplicationRows(
  client: D1ReadClient,
  tableNames: readonly string[],
): Promise<number> {
  const statements = tableNames.map(
    (table): D1Statement => ({
      sql: `SELECT COUNT(*) AS count FROM ${identifier(table)}`,
    }),
  );
  let total = 0;
  for (let offset = 0; offset < statements.length; offset += 50) {
    const chunk = statements.slice(offset, offset + 50);
    const results = client.batchRead
      ? await client.batchRead(chunk)
      : await Promise.all(
          chunk.map((statement) => client.query(statement.sql)),
        );
    for (const result of results) {
      const count = result.rows[0]?.count;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("D1 application row count is invalid");
      }
      total += count;
    }
  }
  return total;
}

async function scalarCount(
  client: D1ReadClient,
  sql: string,
  params: readonly string[],
): Promise<number> {
  const result = await client.query(sql, params);
  const count = result.rows[0]?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("D1 scalar count is invalid");
  }
  return count;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
    value,
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
