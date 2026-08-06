import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const migrationSql = readFileSync(
  new URL(
    "../../apps/web/migrations/0001_finalize_production_schema.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("production schema finalization migration", () => {
  for (const [name, indexSql] of [
    [
      "replaces the obsolete unique content index",
      `CREATE UNIQUE INDEX workshop_template_revisions_content_uidx
         ON workshop_template_revisions (template_id, content_hash)`,
    ],
    [
      "recreates the canonical content index",
      `CREATE INDEX workshop_template_revisions_content_idx
         ON workshop_template_revisions (template_id, content_hash)`,
    ],
  ] as const) {
    test(name, () => {
      const database = fixture(indexSql);
      try {
        database.exec(migrationSql);

        const indexes = database
          .query(
            `SELECT name, "unique" AS is_unique
             FROM pragma_index_list('workshop_template_revisions')
             WHERE name IN (
               'workshop_template_revisions_content_uidx',
               'workshop_template_revisions_content_idx'
             )
             ORDER BY name`,
          )
          .all();
        expect(indexes).toEqual([
          {
            name: "workshop_template_revisions_content_idx",
            is_unique: 0,
          },
        ]);

        expect(() =>
          database
            .query(
              `INSERT INTO workshop_template_revisions
                 (id, template_id, content_hash)
               VALUES ('revision-b', 'template-a', 'content-a')`,
            )
            .run(),
        ).not.toThrow();

        expect(
          database
            .query(
              `SELECT count(*) AS count
               FROM sqlite_schema
               WHERE type = 'table' AND name = 'clean_d1_commissioning'`,
            )
            .get(),
        ).toEqual({ count: 0 });

        expect(
          database
            .query(
              `SELECT id, state, retry_at, completed_at, error_class, error_code,
                      json_extract(sanitized_result_json, '$.confirmedAbsent')
                        AS confirmed_absent,
                      json_extract(sanitized_result_json, '$.historicalRepair')
                        AS historical_repair
               FROM runtime_provider_operations
               ORDER BY id`,
            )
            .all(),
        ).toEqual([
          {
            id: "confirmed-delete",
            state: "succeeded",
            retry_at: null,
            completed_at: 500,
            error_class: null,
            error_code: null,
            confirmed_absent: 1,
            historical_repair: 1,
          },
          {
            id: "unrelated",
            state: "running",
            retry_at: 600,
            completed_at: null,
            error_class: "provider",
            error_code: "pending",
            confirmed_absent: null,
            historical_repair: null,
          },
        ]);
      } finally {
        database.close(false);
      }
    });
  }
});

function fixture(indexSql: string): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    CREATE TABLE workshop_template_revisions (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    ${indexSql};
    INSERT INTO workshop_template_revisions VALUES
      ('revision-a', 'template-a', 'content-a');

    CREATE TABLE clean_d1_commissioning (id TEXT PRIMARY KEY);
    INSERT INTO clean_d1_commissioning VALUES ('first-owner-v1');

    CREATE TABLE runtime_provider_allocations (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      location_attempt INTEGER NOT NULL,
      deletion_confirmed_at INTEGER
    );
    CREATE TABLE runtime_provider_resources (
      id TEXT PRIMARY KEY,
      allocation_id TEXT NOT NULL,
      location_attempt INTEGER NOT NULL,
      resource_kind TEXT NOT NULL,
      disappearance_confirmed_at INTEGER
    );
    CREATE TABLE runtime_provider_operations (
      id TEXT PRIMARY KEY,
      allocation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      location_attempt INTEGER NOT NULL,
      state TEXT NOT NULL,
      retry_at INTEGER,
      last_polled_at INTEGER,
      completed_at INTEGER,
      error_class TEXT,
      error_code TEXT,
      sanitized_result_json TEXT,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO runtime_provider_allocations VALUES
      ('deleted', 'deleted', 1, 500);
    INSERT INTO runtime_provider_resources VALUES
      ('instance', 'deleted', 1, 'instance', 480);
    INSERT INTO runtime_provider_operations VALUES
      ('confirmed-delete', 'deleted', 'delete_instance', 1, 'running', 600,
       NULL, NULL, 'provider', 'pending', NULL, 100),
      ('unrelated', 'deleted', 'reconcile', 1, 'running', 600,
       NULL, NULL, 'provider', 'pending', NULL, 100);
  `);
  return database;
}
