import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const patchSql = readFileSync(
  new URL("./allow-failed-workshop-republication.sql", import.meta.url),
  "utf8",
);

describe("failed Workshop republication schema patch", () => {
  test("replaces the old unique content index and is idempotent", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec(`
        CREATE TABLE workshop_template_revisions (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          content_hash TEXT NOT NULL
        );
        CREATE UNIQUE INDEX workshop_template_revisions_content_uidx
          ON workshop_template_revisions (template_id, content_hash);
      `);
      database
        .query(
          `INSERT INTO workshop_template_revisions
             (id, template_id, content_hash)
           VALUES ('revision-a', 'template-a', 'content-a')`,
        )
        .run();
      expect(() =>
        database
          .query(
            `INSERT INTO workshop_template_revisions
               (id, template_id, content_hash)
             VALUES ('revision-b', 'template-a', 'content-a')`,
          )
          .run(),
      ).toThrow("UNIQUE constraint failed");

      database.exec(patchSql);
      database.exec(patchSql);

      const indexes = database
        .query(
          `SELECT name, "unique" AS is_unique, partial
           FROM pragma_index_list('workshop_template_revisions')
           WHERE name IN (
             'workshop_template_revisions_content_uidx',
             'workshop_template_revisions_content_idx'
           ) ORDER BY name`,
        )
        .all();
      expect(indexes).toEqual([
        {
          name: "workshop_template_revisions_content_idx",
          is_unique: 0,
          partial: 0,
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
    } finally {
      database.close(false);
    }
  });
});
