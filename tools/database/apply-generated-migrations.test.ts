import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { REMOVAL_MIGRATION_IDX } from "./apply-removal-migration";
import {
  applyGeneratedMigrations,
  generatedMigrationBatch,
  migrationStatements,
  planGeneratedMigrations,
} from "./apply-generated-migrations";
import type { D1Statement, D1StatementResult } from "./d1-rest-client";
import {
  BunSqliteD1ReadClient,
  expectedGeneratedD1Schema,
} from "./generated-d1-schema";

/** Every committed generated migration, in journal order. */
const COMMITTED_COUNT = expectedGeneratedD1Schema().committedMigrationCount;
/** The schema before personal-metal fields and credential generations. */
const APPENDED_IDX = 19;

describe("generated migration apply", () => {
  test("plans every committed migration after the observed ledger", async () => {
    const fixture = prefixDatabase(REMOVAL_MIGRATION_IDX);
    try {
      const plan = await planGeneratedMigrations(fixture.client);
      expect(plan.appliedMigrationCount).toBe(REMOVAL_MIGRATION_IDX);
      expect(plan.committedMigrationCount).toBe(COMMITTED_COUNT);
      expect(plan.pending.map(({ tag }) => tag)).toEqual([
        "0013_amused_kinsey_walden",
        "0014_public_sentry",
        "0015_parched_captain_marvel",
        "0016_salty_shiver_man",
        "0017_narrow_angel",
        "0018_exotic_deathbird",
        "0019_military_lightspeed",
        "0020_noisy_plazm",
        "0021_greedy_trish_tilby",
        "0022_petite_colleen_wing",
        "0023_fuzzy_mastermind",
        "0024_white_masque",
        "0025_cheerful_sway",
        "0026_groovy_doctor_octopus",
        "0027_real_big_bertha",
      ]);
    } finally {
      fixture.database.close(false);
    }
  });

  test("applies personal-metal migrations while preserving populated history", async () => {
    const fixture = prefixDatabase(APPENDED_IDX);
    try {
      const client = fixture.client;
      // Populated production-shaped data: a live run and its runtime VM.
      client.database
        .query(
          "INSERT INTO user (id, name, email) VALUES ('u1', 'User', 'u@example.test')",
        )
        .run();
      client.database
        .query(
          "INSERT INTO agent_hosts (id, user_id, name) VALUES ('h1', 'u1', 'Host')",
        )
        .run();
      client.database
        .query(
          "INSERT INTO scenario_runs (run_id, user_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown, objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, revealed_hints_json, solution_assisted, vm_count, state, state_rank, active_key, state_json, created_at, updated_at) VALUES ('run-1', 'u1', 'h1', 's1', 's1', 'T', 't', 'b', '[]', 'beginner', 30, '[]', '[]', 's', '[]', 0, 1, 'provisioning', 1, 'u1', '{}', 1, 1)",
        )
        .run();
      client.database
        .query(
          "INSERT INTO runtime_executions (id, user_id, host_id, domain_kind, domain_id, generation, state) VALUES ('run-1', 'u1', 'h1', 'scenario', 'run-1', 1, 'provisioning')",
        )
        .run();
      client.database
        .query(
          "INSERT INTO runtime_vms (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256, cpu_millis, memory_mib, disk_mib) VALUES ('vm-1', 'run-1', 'vm-1', 0, 'web', '{}', '2222222222222222222222222222222222222222222222222222222222222222', 1000, 512, 4096)",
        )
        .run();

      client.database.query("INSERT INTO host_cpu_reservations (run_id, host_id, cpu_millis, state) VALUES ('run-1', 'h1', 500, 'committed')").run();

      const plan = await planGeneratedMigrations(client);
      expect(plan.appliedMigrationCount).toBe(APPENDED_IDX);
      expect(plan.pending.map(({ tag }) => tag)).toEqual([
        "0019_military_lightspeed",
        "0020_noisy_plazm",
        "0021_greedy_trish_tilby",
        "0022_petite_colleen_wing",
        "0023_fuzzy_mastermind",
        "0024_white_masque",
        "0025_cheerful_sway",
        "0026_groovy_doctor_octopus",
        "0027_real_big_bertha",
      ]);

      const evidence = await applyGeneratedMigrations(client);
      expect(evidence.appliedTags).toEqual(plan.pending.map(({ tag }) => tag));
      expect(evidence.appliedMigrationCount).toBe(COMMITTED_COUNT);
      expect(evidence.foreignKeyViolations).toBe(0);
      expect(client.database.query("SELECT cpu_millis FROM host_cpu_reservations WHERE run_id = 'run-1'").get()).toEqual({ cpu_millis: 500 });
      // Already removed schema stays removed without affecting history.
      expect(
        client.database
          .query(
            "SELECT count(*) AS count FROM pragma_table_info('agent_hosts') WHERE name = 'provider'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        client.database
          .query(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'host_geo_locations'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        client.database
          .query("SELECT name FROM agent_hosts WHERE id = 'h1'")
          .get(),
      ).toEqual({ name: "Host" });
      const columns = client.database.query("SELECT name FROM pragma_table_info('host_cpu_reservations')").all() as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain("boot_cpu_millis");
      expect(columns.map((column) => column.name)).not.toContain("steady_cpu_millis");
      expect(columns.map((column) => column.name)).not.toContain("quota_phase");
      expect(client.database.query("SELECT count(*) AS count FROM pragma_table_info('vm_scenario_vms') WHERE name = 'vcpu_count'").get()).toEqual({ count: 0 });
      expect(client.batches).toHaveLength(COMMITTED_COUNT - APPENDED_IDX);
      for (const batch of client.batches) {
        expect(batch.at(-1)?.sql).toBe("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
      }
      expect(client.database.query("SELECT scope, credential_generation, owner_removal_completed_at FROM agent_hosts WHERE id = 'h1'").get())
        .toEqual({ scope: null, credential_generation: 0, owner_removal_completed_at: null });
      expect(client.database.query("SELECT metal_placement FROM user WHERE id = 'u1'").get())
        .toEqual({ metal_placement: "platform" });

      // The populated rows survive with NULL values in the new columns.
      const run = client.database
        .query(
          "SELECT request_idempotency_key, request_scope_json, route_cleanup_id FROM scenario_runs WHERE run_id = 'run-1'",
        )
        .get() as { request_idempotency_key: string | null; request_scope_json: string | null; route_cleanup_id: string | null };
      expect(run.request_idempotency_key).toBeNull();
      expect(run.request_scope_json).toBeNull();
      expect(run.route_cleanup_id).toBeNull();
      const vm = client.database
        .query(
          "SELECT terminal_attached_at FROM runtime_vms WHERE id = 'vm-1'",
        )
        .get() as { terminal_attached_at: number | null };
      expect(vm.terminal_attached_at).toBeNull();

      // The retired lock table is gone, and the unique index is enforced on the
      // populated table: several runs may hold a NULL key, one may not be
      // duplicated.
      const locks = client.database
        .query(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'runtime_allocation_locks'",
        )
        .get() as { count: number };
      expect(locks.count).toBe(0);
      expect(() => insertRun(client.database, "run-2", null)).not.toThrow();
      expect(() => insertRun(client.database, "run-3", "key-aaaaaaaa")).not.toThrow();
      expect(() => insertRun(client.database, "run-4", "key-aaaaaaaa")).toThrow(
        /UNIQUE/,
      );
    } finally {
      fixture.database.close(false);
    }
  });

  test("rejects a second run that reuses an idempotency key", async () => {
    const fixture = prefixDatabase(COMMITTED_COUNT);
    try {
      const insert = (runId: string, key: string) =>
        fixture.database
          .query(
            "INSERT INTO scenario_runs (run_id, user_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown, objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, revealed_hints_json, solution_assisted, vm_count, state, state_rank, request_idempotency_key, state_json, created_at, updated_at) VALUES (?, 'u1', 'h1', 's1', 's1', 'T', 't', 'b', '[]', 'beginner', 30, '[]', '[]', 's', '[]', 0, 1, 'provisioning', 1, ?, '{}', 1, 1)",
          )
          .run(runId, key);
      fixture.database
        .query("INSERT INTO user (id, name, email) VALUES ('u1', 'U', 'u@example.test')")
        .run();
      fixture.database
        .query("INSERT INTO agent_hosts (id, user_id, name) VALUES ('h1', 'u1', 'H')")
        .run();
      expect(() => insert("run-1", "key-aaaaaaaa")).not.toThrow();
      expect(() => insert("run-2", "key-aaaaaaaa")).toThrow(/UNIQUE/);
    } finally {
      fixture.database.close(false);
    }
  });

  test("rolls a failed migration back completely, marker included", async () => {
    const fixture = prefixDatabase(REMOVAL_MIGRATION_IDX);
    try {
      const plan = await planGeneratedMigrations(fixture.client);
      const batch = generatedMigrationBatch(plan.pending[0]!);
      // A statement that must fail after the migration statements ran. D1 runs
      // a batch in one transaction, so nothing may survive.
      await expect(
        fixture.client.batch([
          ...batch,
          { sql: "INSERT INTO table_that_does_not_exist (id) VALUES (1)" },
        ]),
      ).rejects.toThrow();
      const after = await planGeneratedMigrations(fixture.client);
      expect(after.appliedMigrationCount).toBe(REMOVAL_MIGRATION_IDX);
      const locks = fixture.database
        .query(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'runtime_allocation_locks'",
        )
        .get() as { count: number };
      expect(locks.count).toBe(1);
    } finally {
      fixture.database.close(false);
    }
  });

  test("refuses a ledger that diverged from the committed stream", async () => {
    const fixture = prefixDatabase(REMOVAL_MIGRATION_IDX);
    try {
      fixture.database
        .query(
          "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
        )
        .run("f".repeat(64));
      await expect(planGeneratedMigrations(fixture.client)).rejects.toThrow(
        /does not match/,
      );
      await expect(applyGeneratedMigrations(fixture.client)).rejects.toThrow();
      expect(fixture.client.batches).toHaveLength(0);
    } finally {
      fixture.database.close(false);
    }
  });

  test("applies nothing when D1 already has the committed stream", async () => {
    const fixture = prefixDatabase(COMMITTED_COUNT);
    try {
      const evidence = await applyGeneratedMigrations(fixture.client);
      expect(evidence.appliedTags).toEqual([]);
      expect(evidence.statementCount).toBe(0);
      expect(fixture.client.batches).toHaveLength(0);
    } finally {
      fixture.database.close(false);
    }
  });

  test("keeps the generated statements, including the D1 pragma wrapper", () => {
    expect(migrationStatements(["a;", "  ", "b;"])).toEqual(["a;", "b;"]);
    const statements = migrationStatements(
        // The removal migration keeps its own PRAGMA wrapper: the D1
        // foreign-key exception is part of that generated file.
      readRemovalSql().split("--> statement-breakpoint"),
    );
    expect(statements[0]).toBe("PRAGMA defer_foreign_keys=ON;");
    expect(statements.at(-1)).toBe("PRAGMA defer_foreign_keys=OFF;");
  });
});

/** Inserts one run row with an optional idempotency key. */
function insertRun(
  database: Database,
  runId: string,
  idempotencyKey: string | null,
): void {
  database
    .query(
      "INSERT INTO scenario_runs (run_id, user_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown, objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, revealed_hints_json, solution_assisted, vm_count, state, state_rank, request_idempotency_key, state_json, created_at, updated_at) VALUES (?, 'u1', 'h1', 's1', 's1', 'T', 't', 'b', '[]', 'beginner', 30, '[]', '[]', 's', '[]', 0, 1, 'provisioning', 1, ?, '{}', 1, 1)",
    )
    .run(runId, idempotencyKey);
}

function readRemovalSql(): string {
  return readFileSync(
    fileURLToPath(
      new URL("../../apps/web/migrations/0013_amused_kinsey_walden.sql", import.meta.url),
    ),
    "utf8",
  );
}

/** A write client that applies a batch in one transaction. */
class BunSqliteD1WriteClient extends BunSqliteD1ReadClient {
  readonly batches: D1Statement[][] = [];

  async batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    this.batches.push([...statements]);
    const results: D1StatementResult[] = [];
    // D1 batch semantics: the whole batch commits together or not at all.
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
 * Builds a database whose ledger holds exactly the first appliedCount
 * committed generated migrations, with foreign-key enforcement on.
 */
function prefixDatabase(appliedCount: number): {
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
