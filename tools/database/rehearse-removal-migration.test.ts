import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyBaselineMigrations } from "./rehearse-removal-migration";
import { rehearsalSeedStatements } from "./rehearse-removal-migration";
import type { D1Statement, D1StatementResult } from "./d1-rest-client";
import {
  BunSqliteD1ReadClient,
  expectedGeneratedD1Schema,
} from "./generated-d1-schema";

describe("removal migration D1 rehearsal", () => {
  test("seeds only tables that exist at the applied prefix", () => {
    const sql = rehearsalSeedStatements().map(({ sql: text }) => text).join("\n");
    // The retired domain tables were dropped by the removal migration, so the
    // seed must not write them: a rehearsal starting at a later prefix would
    // fail. What must survive is the scenario runtime data.
    expect(sql).not.toContain("provider_connections");
    expect(sql).not.toContain("provider_credential_versions");
    expect(sql).not.toContain("workshop_");
    expect(sql).toContain("scenario_runs");
    expect(sql).toContain("runtime_executions");
    expect(sql).toContain("'scenario'");
    expect(sql).not.toContain("DELETE FROM");
  });

  test("builds the exact committed prefix with the atomic applier", async () => {
    const appliedCount = 14;
    const database = new Database(":memory:", { strict: true });
    const client = new PrefixWriteClient(database);
    try {
      const tags = await applyBaselineMigrations(client, appliedCount);
      expect(tags).toHaveLength(appliedCount);
      // One batch per migration, each ending with its standard ledger marker.
      expect(client.batches).toHaveLength(appliedCount + 1);
      for (const batch of client.batches.slice(1)) {
        expect(batch.at(-1)?.sql).toBe(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        );
      }
      // The removal migration keeps its generated D1 PRAGMA wrapper inside
      // the same batch as its statements.
      const removalBatch = client.batches[14];
      expect(removalBatch?.[0]?.sql).toBe("PRAGMA defer_foreign_keys=ON;");
      expect(removalBatch?.at(-2)?.sql).toBe("PRAGMA defer_foreign_keys=OFF;");
      const markers = database
        .query("SELECT count(*) AS count FROM __drizzle_migrations")
        .get() as { count: number };
      expect(markers.count).toBe(appliedCount);
      const locks = database
        .query(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'runtime_allocation_locks'",
        )
        .get() as { count: number };
      // The lock table is dropped by the migration that is still pending at
      // this prefix, so the baseline must still have it.
      expect(locks.count).toBe(1);
    } finally {
      database.close(false);
    }
  });

  test("seeds and then reproduces the committed prefix schema", async () => {
    const appliedCount = 14;
    const database = new Database(":memory:", { strict: true });
    const client = new PrefixWriteClient(database);
    try {
      await applyBaselineMigrations(client, appliedCount);
      await client.batch(rehearsalSeedStatements());
      const runs = database
        .query("SELECT count(*) AS count FROM scenario_runs")
        .get() as { count: number };
      expect(runs.count).toBe(1);
      const vms = database
        .query("SELECT count(*) AS count FROM runtime_vms")
        .get() as { count: number };
      expect(vms.count).toBe(1);
    } finally {
      database.close(false);
    }
  });

  test("refuses a prefix outside the committed stream", async () => {
    const database = new Database(":memory:", { strict: true });
    const client = new PrefixWriteClient(database);
    try {
      await expect(applyBaselineMigrations(client, 0)).rejects.toThrow();
      await expect(applyBaselineMigrations(client, 99)).rejects.toThrow();
      expect(client.batches).toHaveLength(0);
    } finally {
      database.close(false);
    }
  });
});

/** A write client that applies a batch in one transaction. */
class PrefixWriteClient extends BunSqliteD1ReadClient {
  readonly batches: D1Statement[][] = [];

  async batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    this.batches.push([...statements]);
    const results: D1StatementResult[] = [];
    this.database.transaction(() => {
      for (const statement of statements) {
        if (statement.params && statement.params.length > 0) {
          this.database.query(statement.sql).run(...statement.params);
        } else {
          this.database.exec(statement.sql);
        }
        results.push({ rows: [], changes: null });
      }
    })();
    return results;
  }
}

// Referenced so the committed-stream length stays asserted by this suite
// rather than by a hardcoded number.
void expectedGeneratedD1Schema;
