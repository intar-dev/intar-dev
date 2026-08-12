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
const retiredBuilderHistoryMigrationSql = readFileSync(
  new URL(
    "../../apps/web/migrations/0002_allow_retired_builder_history_detach.sql",
    import.meta.url,
  ),
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const cleanBaselineSql = readFileSync(
  new URL(
    "../../apps/web/migrations/0000_clean_multicloud.sql",
    import.meta.url,
  ),
  "utf8",
);
const inviteLifecycleMigrationSql = readFileSync(
  new URL(
    "../../apps/web/migrations/0003_archive_access_invites.sql",
    import.meta.url,
  ),
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const legacyInviteBaselineSql = cleanBaselineSql.replace(
  "CHECK (`expires_at` IN (`created_at` + 172800000, `created_at` + 1209600000))",
  "CHECK (`expires_at` = `created_at` + 172800000)",
);

if (legacyInviteBaselineSql === cleanBaselineSql) {
  throw new Error(
    "clean baseline no longer contains the dual invite lifetime check",
  );
}

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

describe("retired builder history migration", () => {
  test("allows only builder-host detachment on a published publication", () => {
    const database = retiredBuilderHistoryFixture();
    try {
      database.exec(retiredBuilderHistoryMigrationSql);

      expect(() =>
        database
          .query(
            `UPDATE workshop_publications
             SET error = 'tampered'
             WHERE id = 'publication-a'`,
          )
          .run(),
      ).toThrow(/published workshop publication is immutable/u);
      expect(() =>
        database
          .query(
            `UPDATE workshop_publications
             SET builder_host_id = NULL, error = 'tampered'
             WHERE id = 'publication-a'`,
          )
          .run(),
      ).toThrow(/published workshop publication is immutable/u);
      expect(() =>
        database
          .query(
            `UPDATE workshop_publications
             SET builder_host_id = 'builder-b'
             WHERE id = 'publication-a'`,
          )
          .run(),
      ).toThrow(/published workshop publication is immutable/u);

      expect(() =>
        database
          .query(
            `UPDATE workshop_publications
             SET builder_host_id = NULL
             WHERE id = 'publication-a'`,
          )
          .run(),
      ).not.toThrow();
      expect(
        database
          .query(
            `SELECT status, certification_state, builder_host_id, error
             FROM workshop_publications
             WHERE id = 'publication-a'`,
          )
          .get(),
      ).toEqual({
        status: "published",
        certification_state: "verified",
        builder_host_id: null,
        error: null,
      });
    } finally {
      database.close(false);
    }
  });
});

describe("invite lifecycle migration", () => {
  test("preserves legacy grants while accepting 48-hour and 14-day invites", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec(legacyInviteBaselineSql);
      seedLegacyInviteGrant(database);

      const invitesBefore = database
        .query("SELECT * FROM access_invite_codes ORDER BY id")
        .all();
      const accessBefore = database
        .query("SELECT * FROM access_allowlist ORDER BY user_id")
        .all();
      const eventsBefore = database
        .query("SELECT * FROM access_events ORDER BY id")
        .all();

      database.exec(inviteLifecycleMigrationSql);

      expect(
        database.query("SELECT * FROM access_invite_codes ORDER BY id").all(),
      ).toEqual(invitesBefore);
      expect(
        database.query("SELECT * FROM access_allowlist ORDER BY user_id").all(),
      ).toEqual(accessBefore);
      expect(
        database.query("SELECT * FROM access_events ORDER BY id").all(),
      ).toEqual(eventsBefore);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const inviteTable = database
        .query(
          `SELECT sql FROM sqlite_schema
           WHERE type = 'table' AND name = 'access_invite_codes'`,
        )
        .get() as { sql: string };
      expect(inviteTable.sql).toContain("172800000");
      expect(inviteTable.sql).toContain("1209600000");

      expect(
        schemaObjectNames(database, "index", "access_invite_codes"),
      ).toEqual([
        "access_invite_codes_creator_idx",
        "access_invite_codes_hash_uidx",
        "access_invite_codes_lease_idx",
        "access_invite_codes_state_expiry_idx",
      ]);
      expect(
        schemaObjectNames(database, "trigger", "access_invite_codes"),
      ).toEqual([
        "access_invite_codes_created_event",
        "access_invite_codes_delete_guard",
        "access_invite_codes_issuer_guard",
        "access_invite_codes_replacement_insert",
        "access_invite_codes_revoker_guard",
        "access_invite_codes_transition_event",
        "access_invite_codes_transition_guard",
      ]);
      expect(
        schemaObjectNames(database, "trigger", "access_allowlist"),
      ).toEqual([
        "access_allowlist_active_delete_guard",
        "access_allowlist_blocked_event",
        "access_allowlist_claim_invite",
        "access_allowlist_cleanup_completed_event",
        "access_allowlist_granted_event",
        "access_allowlist_identity_immutable",
        "access_allowlist_last_admin_guard",
        "access_allowlist_revoker_guard",
      ]);

      expect(() =>
        insertBootstrapInvite(database, "legacy-new", 10_000, 172_800_000),
      ).not.toThrow();
      expect(() =>
        insertBootstrapInvite(
          database,
          "fourteen-day",
          20_000,
          1_209_600_000,
        ),
      ).not.toThrow();
      expect(() =>
        insertBootstrapInvite(database, "wrong-lifetime", 30_000, 86_400_000),
      ).toThrow(/access_invite_codes_expiry_valid/u);
      expect(() =>
        database
          .query(
            `INSERT INTO access_events
               (id, event_type, invite_id, actor_user_id, created_at)
             VALUES ('invalid-remove', 'invite.removed', 'legacy-pending',
                     'admin-a', 40000)`,
          )
          .run(),
      ).toThrow(/invalid access audit event/u);
    } finally {
      database.close(false);
    }
  });
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

function retiredBuilderHistoryFixture(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    CREATE TABLE workshop_publications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      workshop_slug TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_r2_key TEXT NOT NULL,
      compiled_manifest_json TEXT NOT NULL,
      required_checkpoint_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      registry_token_id TEXT NOT NULL,
      builder_host_id TEXT,
      published_revision_id TEXT,
      error TEXT,
      claimed_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claim_expires_at INTEGER,
      runtime_profile_resolutions_json TEXT NOT NULL,
      certification_state TEXT
    );
    CREATE TRIGGER workshop_publications_published_immutable
    BEFORE UPDATE ON workshop_publications
    WHEN OLD.status = 'published'
    BEGIN
      SELECT RAISE(ABORT, 'published workshop publication is immutable');
    END;
    INSERT INTO workshop_publications VALUES (
      'publication-a', 'org-a', 'workshop-a', 'hash-a', 'source-a', '{}', '[]',
      'published', 'user-a', 'token-a', 'builder-a', 'revision-a', NULL, 100,
      200, 50, 200, NULL, '[]', 'verified'
    );
  `);
  return database;
}

function seedLegacyInviteGrant(database: Database): void {
  database.exec(`
    INSERT INTO user (
      id, name, email, email_verified, created_at, updated_at, username,
      display_username, role, banned
    ) VALUES (
      'admin-a', 'Admin A', 'admin-a@example.test', 1, 100, 100,
      'admin-a', 'admin-a', 'admin', 0
    );
    INSERT INTO account (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES ('account-admin-a', 'github-admin-a', 'github', 'admin-a', 100, 100);
    INSERT INTO access_invite_codes (
      id, code_hash, code_prefix, kind, state, label, created_by,
      created_at, expires_at, lease_id, leased_at, lease_expires_at,
      version, updated_at
    ) VALUES (
      'legacy-redeemed', '${"a".repeat(64)}', 'intar_beta_AAAAAAAA',
      'bootstrap_admin', 'leased', 'legacy bootstrap', NULL,
      1000, 172801000, 'legacy-lease', 2000, 602000, 1, 2000
    );
    INSERT INTO access_allowlist (
      user_id, state, github_account_id, github_username, source_invite_id,
      source_lease_id, granted_by, grant_reason, granted_at
    ) VALUES (
      'admin-a', 'active', 'github-admin-a', 'admin-a', 'legacy-redeemed',
      'legacy-lease', NULL, 'bootstrap_admin', 3000
    );
    INSERT INTO access_invite_codes (
      id, code_hash, code_prefix, kind, state, label, created_by,
      created_at, expires_at, version, updated_at
    ) VALUES (
      'legacy-pending', '${"b".repeat(64)}', 'intar_beta_BBBBBBBB',
      'standard', 'pending', 'legacy pending', 'admin-a',
      4000, 172804000, 1, 4000
    );
  `);
}

function insertBootstrapInvite(
  database: Database,
  id: string,
  createdAt: number,
  lifetime: number,
): void {
  database
    .query(
      `INSERT INTO access_invite_codes (
         id, code_hash, code_prefix, kind, state, created_by,
         created_at, expires_at, version, updated_at
       ) VALUES (?, ?, ?, 'bootstrap_admin', 'pending', NULL, ?, ?, 1, ?)`,
    )
    .run(
      id,
      id === "legacy-new"
        ? "c".repeat(64)
        : id === "fourteen-day"
          ? "d".repeat(64)
          : "e".repeat(64),
      `intar_beta_${id.slice(0, 8).padEnd(8, "X")}`,
      createdAt,
      createdAt + lifetime,
      createdAt,
    );
}

function schemaObjectNames(
  database: Database,
  type: "index" | "trigger",
  tableName: string,
): string[] {
  return database
    .query(
      `SELECT name FROM sqlite_schema
       WHERE type = ? AND tbl_name = ? AND name NOT LIKE 'sqlite_autoindex_%'
       ORDER BY name`,
    )
    .all(type, tableName)
    .map((row) => (row as { name: string }).name);
}
