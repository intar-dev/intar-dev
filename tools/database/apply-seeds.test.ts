import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applySeeds, readSeeds, seedStatement } from "./apply-seeds";
import { applyGeneratedPrefix } from "./apply-generated-migrations";
import type { D1Statement, D1StatementResult } from "./d1-rest-client";
import { BunSqliteD1ReadClient } from "./generated-d1-schema";

class WriteClient extends BunSqliteD1ReadClient {
  async batch(statements: readonly D1Statement[]): Promise<readonly D1StatementResult[]> {
    const results: D1StatementResult[] = [];
    this.database.transaction(() => {
      for (const { sql, params } of statements) {
        const changes = params?.length ? this.database.query(sql).run(...params).changes : this.database.run(sql).changes;
        results.push({ rows: [], changes });
      }
    })();
    return results;
  }
}

describe("production seeds", () => {
  test("add the desktop app's OAuth client once and never change it", async () => {
    const database = new Database(":memory:", { strict: true });
    try {
      const client = new WriteClient(database);
      // Every committed migration, as production has them after a deploy.
      await applyGeneratedPrefix(client, JSON.parse(readFileSync(
        new URL("../../apps/web/migrations/meta/_journal.json", import.meta.url), "utf8")).entries.length);

      expect(await applySeeds(client)).toEqual([{ name: "desktop-oauth-client.sql", added: 1 }]);
      expect(database.query("SELECT client_id, user_id, public, require_pkce, skip_consent, disabled, token_endpoint_auth_method, scopes FROM oauth_client").all())
        .toEqual([{ client_id: "intar-jumper", user_id: null, public: 1, require_pkce: 1, skip_consent: 0, disabled: 0,
          token_endpoint_auth_method: "none", scopes: '["offline_access","local-runs"]' }]);

      // An operator turned the app's sign-in off: the next deploy leaves that alone.
      database.run("UPDATE oauth_client SET disabled = 1");
      expect(await applySeeds(client)).toEqual([{ name: "desktop-oauth-client.sql", added: 0 }]);
      expect(database.query("SELECT disabled FROM oauth_client").all()).toEqual([{ disabled: 1 }]);
    } finally {
      database.close(false);
    }
  });

  test("every committed seed only adds a missing row", () => {
    expect(readSeeds().map((seed) => seed.name)).toEqual(["desktop-oauth-client.sql"]);
    for (const sql of [
      "UPDATE oauth_client SET disabled = 0",
      "DELETE FROM oauth_client",
      "INSERT INTO t (a) VALUES (1)",
      "INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 2",
      "INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING; DELETE FROM t",
    ]) expect(() => seedStatement("bad.sql", sql), sql).toThrow(/a seed is/u);
    expect(seedStatement("ok.sql", "-- why\nINSERT INTO t (a) VALUES (1)\nON CONFLICT DO NOTHING;\n"))
      .toBe("INSERT INTO t (a) VALUES (1)\nON CONFLICT DO NOTHING");
  });
});
