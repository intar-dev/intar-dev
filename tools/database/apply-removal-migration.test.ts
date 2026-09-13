import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Statement, D1StatementResult } from "./d1-rest-client";
import {
  REMOVAL_MIGRATION_IDX,
  applyRemovalMigration,
  removalMigrationBatch,
  removalMigrationEntry,
} from "./apply-removal-migration";
import {
  BunSqliteD1ReadClient,
  expectedGeneratedD1Schema,
} from "./generated-d1-schema";

describe("removal migration D1 batch", () => {
  test("keeps the generated migration and ledger marker in one batch", () => {
    const batch = removalMigrationBatch();
    expect(batch[0]?.sql).toBe("PRAGMA defer_foreign_keys=ON;");
    expect(batch.at(-2)?.sql).toBe("PRAGMA defer_foreign_keys=OFF;");
    expect(batch.at(-1)?.sql).toBe(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    );
    expect(batch.at(-1)?.params?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.some(({ sql }) => sql.includes("runtime_executions"))).toBe(
      false,
    );
  });

  test("reads the removal migration by index, not the newest journal entry", () => {
    const entry = removalMigrationEntry();
    expect(entry.idx).toBe(REMOVAL_MIGRATION_IDX);
    // The batch carries the removal migration statements. A batch built from
    // the newest journal entry would carry the appended migration instead.
    const sql = removalMigrationBatch()
      .map(({ sql: statement }) => statement)
      .join("\n");
    expect(sql).not.toContain("runtime_allocation_locks");
  });

  test("applies the removal migration from the explicit boundary", async () => {
    const fixture = removalBoundaryDatabase(REMOVAL_MIGRATION_IDX);
    try {
      const result = await applyRemovalMigration(fixture.client);
      expect(result.appliedMigrationCount).toBe(REMOVAL_MIGRATION_IDX + 1);
      // The appended migration stays in the committed stream and is not
      // demanded from this workflow.
      expect(result.committedMigrationCount).toBeGreaterThan(
        REMOVAL_MIGRATION_IDX + 1,
      );
      const applied = fixture.client.batches.at(-1);
      expect(applied?.[0]?.sql).toBe("PRAGMA defer_foreign_keys=ON;");
      expect(applied?.at(-1)?.params?.[1]).toBe(removalMigrationEntry().when);
    } finally {
      fixture.database.close(false);
    }
  });

  test("refuses a database that is not exactly at the removal boundary", async () => {
    const fixture = removalBoundaryDatabase(REMOVAL_MIGRATION_IDX + 1);
    try {
      await expect(applyRemovalMigration(fixture.client)).rejects.toThrow(
        /the removal migration applies from exactly/,
      );
      // The refusal happens before any write reaches the database.
      expect(fixture.client.batches).toHaveLength(0);
    } finally {
      fixture.database.close(false);
    }
  });
});

/** A write client that applies a batch to the in-memory database. */
class BunSqliteD1WriteClient extends BunSqliteD1ReadClient {
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

/**
 * Builds a database that has applied exactly the first appliedCount
 * committed migrations, including its ledger markers.
 */
function removalBoundaryDatabase(appliedCount: number): {
  database: Database;
  client: BunSqliteD1WriteClient;
} {
  const proof = expectedGeneratedD1Schema(appliedCount);
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  for (const object of proof.objects.filter(({ type }) => type === "table")) {
    database.exec(object.sql);
  }
  for (const object of proof.objects.filter(({ type }) => type === "index")) {
    database.exec(object.sql);
  }
  for (const marker of proof.migrations) {
    database
      .query(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run(marker.hash, marker.createdAt);
  }
  return { database, client: new BunSqliteD1WriteClient(database) };
}
