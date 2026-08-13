import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BunSqliteD1ReadClient,
  expectedGeneratedD1Schema,
  verifyGeneratedD1Schema,
} from "./generated-d1-schema";

describe("exact generated D1 schema verifier", () => {
  test("accepts the full generated schema and ledger", async () => {
    const fixture = generatedDatabase();
    try {
      await expect(verifyGeneratedD1Schema(fixture.client)).resolves.toMatchObject({
        status: "exact_generated_schema_verified",
        expectation: "full",
        foreignKeyViolations: 0,
        triggers: 0,
        views: 0,
      });
    } finally {
      fixture.database.close(false);
    }
  });

  test("rejects a same-name index with changed columns", async () => {
    const fixture = generatedDatabase();
    try {
      const index = fixture.database
        .query(
          `SELECT s.name, s.tbl_name AS table_name, s.sql,
                  (SELECT name FROM pragma_table_info(s.tbl_name) LIMIT 1) AS replacement_column
           FROM sqlite_schema s
           WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1`,
        )
        .get() as {
          name: string;
          table_name: string;
          sql: string;
          replacement_column: string;
        };
      fixture.database.exec(`DROP INDEX ${quote(index.name)}`);
      fixture.database.exec(
        `CREATE INDEX ${quote(index.name)} ON ${quote(index.table_name)} (${quote(index.replacement_column)})`,
      );
      await expect(verifyGeneratedD1Schema(fixture.client)).rejects.toThrow(
        "schema differs",
      );
    } finally {
      fixture.database.close(false);
    }
  });

  test("rejects a same-name nonunique replacement for a unique index", async () => {
    const fixture = generatedDatabase();
    try {
      const index = fixture.database
        .query(
          `SELECT name, tbl_name AS table_name, sql FROM sqlite_schema
           WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%'
           ORDER BY name LIMIT 1`,
        )
        .get() as { name: string; table_name: string; sql: string };
      const columns = index.sql.slice(index.sql.lastIndexOf("("));
      fixture.database.exec(`DROP INDEX ${quote(index.name)}`);
      fixture.database.exec(
        `CREATE INDEX ${quote(index.name)} ON ${quote(index.table_name)} ${columns}`,
      );
      await expect(verifyGeneratedD1Schema(fixture.client)).rejects.toThrow(
        "schema differs",
      );
    } finally {
      fixture.database.close(false);
    }
  });

  test("rejects changed defaults or removed checks in a recreated table", async () => {
    for (const mutation of [
      (sql: string) => sql.replace("DEFAULT 'pending'", "DEFAULT 'redeemed'"),
      (sql: string) =>
        sql.replace(
          /,\nCONSTRAINT "access_invite_codes_hash_valid" CHECK\([^\n]+\)/u,
          "",
        ),
    ]) {
      const fixture = generatedDatabase();
      try {
        const table = fixture.database
          .query(
            `SELECT name, sql FROM sqlite_schema
             WHERE type = 'table' AND name = 'access_invite_codes'`,
          )
          .get() as { name: string; sql: string };
        const replacement = `${table.name}_replacement`;
        const changed = mutation(table.sql.replaceAll(table.name, replacement))
          .replaceAll(`"${replacement}".`, "");
        expect(changed).not.toBe(table.sql);
        fixture.database.exec("PRAGMA foreign_keys = OFF");
        fixture.database.exec(changed);
        fixture.database.exec(`DROP TABLE ${quote(table.name)}`);
        fixture.database.exec(
          `ALTER TABLE ${quote(replacement)} RENAME TO ${quote(table.name)}`,
        );
        await expect(verifyGeneratedD1Schema(fixture.client)).rejects.toThrow(
          "schema differs",
        );
      } finally {
        fixture.database.close(false);
      }
    }
  });

  test("rejects every kind of extra custom schema object", async () => {
    for (const ddl of [
      "CREATE TABLE extra_table (id text PRIMARY KEY)",
      "CREATE INDEX extra_index ON user (name)",
      "CREATE VIEW extra_view AS SELECT id FROM user",
      "CREATE TRIGGER extra_trigger AFTER INSERT ON user BEGIN SELECT 1; END",
    ]) {
      const fixture = generatedDatabase();
      try {
        fixture.database.exec(ddl);
        await expect(verifyGeneratedD1Schema(fixture.client)).rejects.toThrow();
      } finally {
        fixture.database.close(false);
      }
    }
  });

  test("rejects a malformed Drizzle ledger table with valid marker rows", async () => {
    const fixture = generatedDatabase();
    try {
      fixture.database.exec("ALTER TABLE __drizzle_migrations ADD COLUMN note text");
      await expect(verifyGeneratedD1Schema(fixture.client)).rejects.toThrow(
        "schema differs",
      );
    } finally {
      fixture.database.close(false);
    }
  });
});

function generatedDatabase(): {
  database: Database;
  client: BunSqliteD1ReadClient;
} {
  const proof = expectedGeneratedD1Schema();
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
  return { database, client: new BunSqliteD1ReadClient(database) };
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
