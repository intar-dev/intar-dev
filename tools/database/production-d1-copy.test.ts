import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  D1ReadClient,
  D1Row,
  D1Statement,
  D1StatementResult,
  D1Value,
  D1WriteClient,
} from "./d1-rest-client";
import { parseArguments } from "./copy-production-d1";
import {
  loadCommittedDrizzleArtifacts,
  runProductionD1Copy,
  validateManifest,
  verifySourceUnchangedAfterCopy,
} from "./production-d1-copy";
import {
  APPLICATION_TABLES,
  COPY_TABLES,
  EXCLUDED_TABLES,
  transformCopiedRow,
} from "./production-d1-copy-manifest";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CUTOVER_AT = 1_800_000_000_000;
const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));

describe("production D1 copy manifest", () => {
  test("exhaustively covers the generated Drizzle schema", () => {
    const artifacts = loadCommittedDrizzleArtifacts();
    expect(() => validateManifest(artifacts.snapshot)).not.toThrow();
    expect(COPY_TABLES.length + EXCLUDED_TABLES.length).toBe(
      APPLICATION_TABLES.length,
    );
  });

  test("normalizes capabilities and live connection state", () => {
    expect(
      transformCopiedRow(
        "access_invite_codes",
        {
          state: "leased",
          lease_id: "lease",
          leased_at: 10,
          lease_expires_at: 600_010,
          version: 2,
          updated_at: 10,
        },
        CUTOVER_AT,
      ),
    ).toMatchObject({
      state: "pending",
      lease_id: null,
      leased_at: null,
      lease_expires_at: null,
      version: 3,
      updated_at: CUTOVER_AT,
    });
    expect(
      transformCopiedRow(
        "agent_hosts",
        { connected: 1, active_session_id: "session", updated_at: 1 },
        CUTOVER_AT,
      ),
    ).toMatchObject({
      connected: 0,
      active_session_id: null,
      disconnected_at: CUTOVER_AT,
      updated_at: CUTOVER_AT,
    });
  });
});

describe("production D1 copy CLI", () => {
  test("requires explicit unequal databases, mode, and evidence path", () => {
    expect(
      parseArguments([
        "--source-database-id",
        SOURCE_ID,
        "--target-database-id",
        TARGET_ID,
        "--dry-run",
        "--evidence",
        "copy.json",
      ]),
    ).toMatchObject({
      mode: "dry-run",
      sourceDatabaseId: SOURCE_ID,
      targetDatabaseId: TARGET_ID,
    });
    expect(() =>
      parseArguments([
        "--source-database-id",
        SOURCE_ID,
        "--target-database-id",
        SOURCE_ID,
        "--apply",
        "--evidence",
        "copy.json",
      ]),
    ).toThrow("must be different");
  });
});

describe("production D1 copy", () => {
  test("copies only allowlisted durable rows and verifies transformed hashes", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      const evidence = await runProductionD1Copy({
        mode: "apply",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        targetDatabaseId: TARGET_ID,
        source,
        target,
        cutoverAt: CUTOVER_AT,
        pageSize: 2,
        maxRowsPerTable: 100,
        maxTotalRows: 1_000,
      });

      expect(evidence.status).toBe("copy_verified");
      expect(evidence.copiedRows).toBe(7);
      expect(evidence.sourceAfter).toEqual(evidence.sourceBefore);
      expect(evidence.targetAfter).toEqual(evidence.sourceBefore);
      expect(
        target.database
          .query(
            `SELECT state, lease_id, version, updated_at FROM access_invite_codes`,
          )
          .get(),
      ).toEqual({
        state: "pending",
        lease_id: null,
        version: 2,
        updated_at: CUTOVER_AT,
      });
      expect(
        target.database
          .query(
            `SELECT access_token, refresh_token, id_token, scope FROM account`,
          )
          .get(),
      ).toEqual({
        access_token: null,
        refresh_token: null,
        id_token: null,
        scope: null,
      });
      expect(
        target.database
          .query(
            `SELECT connected, active_session_id, disconnected_at FROM agent_hosts`,
          )
          .get(),
      ).toEqual({
        connected: 0,
        active_session_id: null,
        disconnected_at: CUTOVER_AT,
      });
      const token = target.database
        .query(`SELECT token_hash, revoked_at FROM workshop_registry_tokens`)
        .get() as { token_hash: string; revoked_at: number };
      expect(token.token_hash).not.toBe("a".repeat(64));
      expect(token.revoked_at).toBe(CUTOVER_AT - 9_999);
      expect(
        target.database.query(`SELECT count(*) AS count FROM session`).get(),
      ).toEqual({ count: 0 });
    } finally {
      source.close();
      target.close();
    }
  });

  test("fails closed before writing when nonterminal work exists", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      source.database
        .query(
          `INSERT INTO invitation
             (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "invitation-1",
          "org-1",
          "invitee@example.test",
          "member",
          "pending",
          CUTOVER_AT + 1_000,
          CUTOVER_AT - 1_000,
          "user-1",
        );

      await expect(
        runProductionD1Copy({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          source,
          target,
          cutoverAt: CUTOVER_AT,
        }),
      ).rejects.toThrow("organization_invitations=1");
      expect(
        target.database.query(`SELECT count(*) AS count FROM user`).get(),
      ).toEqual({ count: 0 });
    } finally {
      source.close();
      target.close();
    }
  });

  test("rejects a populated target before reading source data", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      target.database
        .query(
          `INSERT INTO user
             (id, name, email, email_verified, created_at, updated_at, banned)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "target-user",
          "Target User",
          "target@example.test",
          1,
          CUTOVER_AT,
          CUTOVER_AT,
          0,
        );

      await expect(
        runProductionD1Copy({
          mode: "dry-run",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          source,
          target,
          cutoverAt: CUTOVER_AT,
        }),
      ).rejects.toThrow("target is not fresh: user=1");
    } finally {
      source.close();
      target.close();
    }
  });

  test("rejects a source mutation that races the copy", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      const racingSource = new MutatingReadClient(source);

      await expect(
        runProductionD1Copy({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          source: racingSource,
          target,
          cutoverAt: CUTOVER_AT,
        }),
      ).rejects.toThrow("source changed during copy");
    } finally {
      source.close();
      target.close();
    }
  });

  test("rejects unknown source tables before writing the target", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      source.database.exec(
        "CREATE TABLE legacy_business_data (id text PRIMARY KEY, payload text NOT NULL)",
      );
      await expect(
        runProductionD1Copy({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          source,
          target,
          cutoverAt: CUTOVER_AT,
        }),
      ).rejects.toThrow("unknown tables");
      expect(
        target.database.query("SELECT count(*) AS count FROM user").get(),
      ).toEqual({ count: 0 });
    } finally {
      source.close();
      target.close();
    }
  });

  test("rejects extra source columns before writing the target", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      source.database.exec("ALTER TABLE user ADD COLUMN durable_note text");
      await expect(
        runProductionD1Copy({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          source,
          target,
          cutoverAt: CUTOVER_AT,
        }),
      ).rejects.toThrow("columns do not exactly match");
      expect(
        target.database.query("SELECT count(*) AS count FROM user").get(),
      ).toEqual({ count: 0 });
    } finally {
      source.close();
      target.close();
    }
  });

  test("accepts legacy ALTER column order when the exact name set matches", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      source.database.exec(`
        ALTER TABLE verification RENAME TO verification_current;
        CREATE TABLE verification (
          id text PRIMARY KEY NOT NULL,
          updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
          identifier text NOT NULL,
          value text NOT NULL,
          expires_at integer NOT NULL,
          created_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
        );
        DROP TABLE verification_current;
      `);
      await expect(
        runProductionD1Copy({
          mode: "dry-run",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          source,
          target,
          cutoverAt: CUTOVER_AT,
        }),
      ).resolves.toMatchObject({ status: "preflight_passed" });
    } finally {
      source.close();
      target.close();
    }
  });

  test("re-fingerprints a stable source after target activation", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      const copyEvidence = await runProductionD1Copy({
        mode: "apply",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        targetDatabaseId: TARGET_ID,
        source,
        target,
        cutoverAt: CUTOVER_AT,
      });
      await expect(
        verifySourceUnchangedAfterCopy({
          source,
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          copyEvidence,
        }),
      ).resolves.toMatchObject({
        version: 1,
        status: "source_unchanged_after_target_activation",
        sourceDatabaseId: SOURCE_ID,
        targetDatabaseId: TARGET_ID,
        sourceAllExpected: copyEvidence.sourceAllAfter,
        sourceAllObserved: copyEvidence.sourceAllAfter,
      });
    } finally {
      source.close();
      target.close();
    }
  });

  test("rejects source changes after the copy returned", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      const copyEvidence = await runProductionD1Copy({
        mode: "apply",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        targetDatabaseId: TARGET_ID,
        source,
        target,
        cutoverAt: CUTOVER_AT,
      });
      source.database.query("UPDATE user SET name = ? WHERE id = ?").run(
        "Changed after copy",
        "user-1",
      );
      await expect(
        verifySourceUnchangedAfterCopy({
          source,
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          copyEvidence,
        }),
      ).rejects.toThrow("source changed during copy");
    } finally {
      source.close();
      target.close();
    }
  });

  test("rejects source verification bound to dry-run or stale IDs", async () => {
    const source = generatedDatabase({ legacySource: true });
    const target = generatedDatabase();
    try {
      seedDurableRows(source.database);
      const dryRun = await runProductionD1Copy({
        mode: "dry-run",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        targetDatabaseId: TARGET_ID,
        source,
        target,
        cutoverAt: CUTOVER_AT,
      });
      await expect(
        verifySourceUnchangedAfterCopy({
          source,
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: TARGET_ID,
          copyEvidence: dryRun,
        }),
      ).rejects.toThrow("verified v1 apply");
      await expect(
        verifySourceUnchangedAfterCopy({
          source,
          sourceDatabaseId: SOURCE_ID,
          targetDatabaseId: "33333333-3333-4333-8333-333333333333",
          copyEvidence: { ...dryRun, mode: "apply", status: "copy_verified" },
        }),
      ).rejects.toThrow("database IDs do not match");
    } finally {
      source.close();
      target.close();
    }
  });
});

class SqliteClient implements D1ReadClient, D1WriteClient {
  constructor(readonly database: Database) {}

  async query(
    sql: string,
    params: readonly D1Value[] = [],
  ): Promise<D1StatementResult> {
    return execute(this.database, { sql, params });
  }

  async batchRead(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return statements.map((statement) => execute(this.database, statement));
  }

  async batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return this.database.transaction(() =>
      statements.map((statement) => execute(this.database, statement)),
    )();
  }

  close(): void {
    this.database.close(false);
  }
}

class MutatingReadClient implements D1ReadClient {
  #sessionPageReads = 0;

  constructor(readonly inner: SqliteClient) {}

  async query(
    sql: string,
    params: readonly D1Value[] = [],
  ): Promise<D1StatementResult> {
    if (/FROM\s+"session"\s+WHERE rowid/iu.test(sql)) {
      this.#sessionPageReads += 1;
      if (this.#sessionPageReads === 2) {
        this.inner.database
          .query(
            `INSERT INTO session
               (id, expires_at, token, created_at, updated_at, user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "racing-session",
            CUTOVER_AT + 60_000,
            "racing-session-token",
            CUTOVER_AT,
            CUTOVER_AT,
            "user-1",
          );
      }
    }
    return this.inner.query(sql, params);
  }

  async batchRead(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return this.inner.batchRead(statements);
  }
}

function generatedDatabase(
  options: { legacySource?: boolean } = {},
): SqliteClient {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  const baseline = readFileSync(`${webRoot}migrations/0000_init.sql`, "utf8");
  for (const statement of baseline
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    database.exec(statement);
  }
  database.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n\tid SERIAL PRIMARY KEY,\n\thash text NOT NULL,\n\tcreated_at numeric\n)',
  );
  const journal = JSON.parse(
    readFileSync(`${webRoot}migrations/meta/_journal.json`, "utf8"),
  ) as { entries: Array<{ when: number }> };
  database
    .query(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
    .run(
      createHash("sha256").update(baseline).digest("hex"),
      journal.entries[0]!.when,
    );
  if (options.legacySource) database.exec("DROP TABLE access_invite_removals");
  return new SqliteClient(database);
}

function execute(
  database: Database,
  statement: D1Statement,
): D1StatementResult {
  const prepared = database.query(statement.sql);
  const params = [...(statement.params ?? [])];
  if (/^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(statement.sql)) {
    return {
      rows: prepared.all(...params) as D1Row[],
      changes: null,
    };
  }
  const result = prepared.run(...params);
  return { rows: [], changes: result.changes };
}

function seedDurableRows(database: Database): void {
  const createdAt = CUTOVER_AT - 10_000;
  database
    .query(
      `INSERT INTO user
         (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "user-1",
      "User One",
      "user@example.test",
      1,
      createdAt,
      createdAt,
      "admin",
      0,
    );
  database
    .query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run("org-1", "Organization", "organization", createdAt);
  database
    .query(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("member-1", "org-1", "user-1", "owner", createdAt);
  database
    .query(
      `INSERT INTO account
         (id, account_id, provider_id, user_id, access_token, refresh_token,
          id_token, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "account-1",
      "github-1",
      "github",
      "user-1",
      "access-secret",
      "refresh-secret",
      "id-secret",
      "read:user",
      createdAt,
      createdAt,
    );
  database
    .query(
      `INSERT INTO access_invite_codes
         (id, code_hash, code_prefix, kind, state, created_by, created_at,
          expires_at, lease_id, leased_at, lease_expires_at, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "invite-1",
      "1".repeat(64),
      "invite",
      "standard",
      "leased",
      "user-1",
      createdAt,
      createdAt + 1_209_600_000,
      "lease-1",
      createdAt + 1_000,
      createdAt + 601_000,
      1,
      createdAt + 1_000,
    );
  database
    .query(
      `INSERT INTO agent_hosts
         (id, user_id, organization_id, name, role, scenario_enabled, disabled,
          connected, connected_at, active_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "host-1",
      "user-1",
      "org-1",
      "Host",
      "agent",
      1,
      0,
      0,
      null,
      null,
      createdAt,
      createdAt,
    );
  database
    .query(
      `INSERT INTO workshop_registry_tokens
         (id, organization_id, name, token_prefix, token_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "registry-1",
      "org-1",
      "Registry",
      "token",
      "a".repeat(64),
      "user-1",
      createdAt,
    );
  database
    .query(`UPDATE workshop_registry_tokens SET revoked_at = ? WHERE id = ?`)
    .run(createdAt + 1, "registry-1");
}
