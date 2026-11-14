import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applyBaselineMigrations,
  comparePreservedTables,
  rehearsalSeedStatements,
  runRehearsal,
  snapshotTables,
} from "./rehearse-removal-migration";
import { applyGeneratedMigrations } from "./apply-generated-migrations";
import type { D1Statement, D1StatementResult } from "./d1-rest-client";
import { BunSqliteD1ReadClient } from "./generated-d1-schema";

/** The production baseline: every committed migration before the removal. */
const BASELINE = 46;

describe("removal migration D1 rehearsal", () => {
  test("seeds the post-wipe baseline: no run, no execution", () => {
    const sql = rehearsalSeedStatements().map(({ sql: text }) => text).join("\n");
    expect(sql).not.toContain("scenario_runs");
    expect(sql).not.toContain("runtime_executions");
    expect(sql).not.toContain("runtime_vms");
    expect(sql).toContain("INSERT INTO vm_scenarios");
    expect(sql).toContain("INSERT INTO image_builds");
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
      // A generated D1 PRAGMA wrapper stays inside the same batch as its
      // statements.
      const wrappedBatch = client.batches[14];
      expect(wrappedBatch?.[0]?.sql).toBe("PRAGMA defer_foreign_keys=ON;");
      expect(wrappedBatch?.at(-2)?.sql).toBe("PRAGMA defer_foreign_keys=OFF;");
      const markers = database
        .query("SELECT count(*) AS count FROM __drizzle_migrations")
        .get() as { count: number };
      expect(markers.count).toBe(appliedCount);
    } finally {
      database.close(false);
    }
  });

  test("keeps every surviving row byte for byte and drops only the retired tables", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    try {
      const evidence = await runRehearsal({
        client: new PrefixWriteClient(database),
        appliedCount: BASELINE,
      });
      expect(evidence.appliedTags).toHaveLength(1);
      expect(evidence.appliedMigrationCount).toBe(evidence.committedMigrationCount);
      expect(evidence.foreignKeyViolations).toBe(0);
      expect(evidence.droppedTables).toEqual([
        "image_build_bundles",
        "image_build_coordination_locks",
        "image_builds",
        "scenario_catalog_candidates",
        "scenario_catalog_snapshots",
        "scenario_run_probe_snapshots",
        "vm_scenario_probes",
        "vm_scenario_vms",
        "vm_scenarios",
      ]);
      // Every seeded row outside the retired tables survives.
      const retired = new Set(evidence.droppedTables);
      const seeded = rehearsalSeedStatements().filter(
        ({ sql }) => !retired.has(/^INSERT INTO (\w+)/u.exec(sql)?.[1] ?? ""),
      );
      expect(evidence.preservedRows).toBe(seeded.length);
    } finally {
      database.close(false);
    }
  });

  test("applies on a post-wipe database with an empty runtime_vms", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    const client = new PrefixWriteClient(database);
    try {
      await applyBaselineMigrations(client, BASELINE);
      const applied = await applyGeneratedMigrations(client);
      expect(applied.appliedTags).toHaveLength(1);
      const columns = database
        .query("SELECT name FROM pragma_table_info('runtime_vms') ORDER BY cid")
        .all() as Array<{ name: string }>;
      const names = columns.map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining(["image_digest", "spec_digest", "kino_digest"]));
      expect(names).not.toContain("image_key_json");
      expect(names).not.toContain("image_sha256");
    } finally {
      database.close(false);
    }
  });

  test("fails and changes nothing when runtime_vms still holds a row", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    const client = new PrefixWriteClient(database);
    try {
      await applyBaselineMigrations(client, BASELINE);
      await client.batch([
        ...rehearsalSeedStatements(),
        { sql: "INSERT INTO runtime_executions (id, user_id, host_id, domain_kind, domain_id, generation, state) VALUES ('run-1', 'user-1', 'host-1', 'scenario', 'run-1', 1, 'provisioning')" },
        { sql: "INSERT INTO runtime_vms (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256, cpu_millis, memory_mib, disk_mib) VALUES ('runtime-vm-1', 'run-1', 'vm-1', 0, 'server', '{}', '" + "a".repeat(64) + "', 1000, 1024, 4096)" },
      ]);
      const before = await snapshotTables(client);
      // The old row has no digests to copy, so the rebuild refuses it.
      await expect(applyGeneratedMigrations(client)).rejects.toThrow(/CHECK constraint failed/u);
      const after = await snapshotTables(client);
      expect([...after.keys()]).toEqual([...before.keys()]);
      expect(comparePreservedTables(before, after).droppedTables).toEqual([]);
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

  test("refuses a changed row, a changed definition and an added table", () => {
    const table = { sql: "CREATE TABLE t (a)", rows: ["'x'"] };
    const before = new Map([["t", table]]);
    expect(() => comparePreservedTables(before, new Map([["t", { ...table, rows: ["'y'"] }]]))).toThrow(/rows of t/u);
    expect(() => comparePreservedTables(before, new Map([["t", { ...table, sql: "CREATE TABLE t (b)" }]]))).toThrow(/definition of t/u);
    expect(() => comparePreservedTables(before, new Map([["t", table], ["u", table]]))).toThrow(/added the table u/u);
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
