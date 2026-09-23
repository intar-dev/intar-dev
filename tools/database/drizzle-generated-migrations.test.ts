import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { pruneDrizzleSnapshots } from "./prune-drizzle-snapshots";
import {
  REMOVAL_MIGRATION_IDX,
  REMOVAL_MIGRATION_TAG,
  removalMigrationEntry,
} from "./apply-removal-migration";
import { rehearsalSeedStatements } from "./rehearse-removal-migration";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = join(repositoryRoot, "apps/web");
const migrationsRoot = join(webRoot, "migrations");
const metadataRoot = join(migrationsRoot, "meta");

interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

describe("Drizzle-generated D1 migrations", () => {
  test("keeps every migration paired with generated metadata", () => {
    const journal = readJson<DrizzleJournal>(join(metadataRoot, "_journal.json"));
    const migrationFiles = readdirSync(migrationsRoot)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const snapshotFiles = readdirSync(metadataRoot)
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort();
    const finalEntry = journal.entries.at(-1);
    if (!finalEntry) throw new Error("Drizzle journal has no migrations");

    expect(journal.dialect).toBe("sqlite");
    expect(journal.entries.map(({ tag }) => `${tag}.sql`)).toEqual(
      migrationFiles,
    );
    expect(snapshotFiles).toEqual([
      `${String(finalEntry.idx).padStart(4, "0")}_snapshot.json`,
    ]);
    expect(journal.entries.map(({ idx }) => idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    expect(journal.entries.every(({ breakpoints }) => breakpoints)).toBe(true);
  });

  test("contains no custom trigger or view SQL", () => {
    const migrationFiles = readdirSync(migrationsRoot).filter((name) =>
      name.endsWith(".sql"),
    );

    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const migrationFile of migrationFiles) {
      const sql = readFileSync(join(migrationsRoot, migrationFile), "utf8");
      expect(sql).not.toMatch(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/iu);
      expect(sql).not.toMatch(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\b/iu);
    }
  });

  test("keeps only the latest generated snapshot", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "intar-drizzle-snapshots-"));
    try {
      for (const name of ["0009_snapshot.json", "0010_snapshot.json", "_journal.json"]) {
        writeFileSync(join(temporaryRoot, name), "{}");
      }
      pruneDrizzleSnapshots(temporaryRoot);
      expect(readdirSync(temporaryRoot).sort()).toEqual([
        "0010_snapshot.json",
        "_journal.json",
      ]);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("applies the generated migration stream to an empty SQLite database", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.transaction(() => {
        const journal = readJson<DrizzleJournal>(
          join(metadataRoot, "_journal.json"),
        );
        for (const entry of journal.entries) {
          const migration = readFileSync(
            join(migrationsRoot, `${entry.tag}.sql`),
            "utf8",
          );
          const statements = migration
            .split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter(Boolean);
          for (const statement of statements) database.exec(statement);
        }
      })();

      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .query(
            "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close(false);
    }
  });

test("selects the removal migration by index when a later migration is appended", () => {
    const journal = readJson<DrizzleJournal>(join(metadataRoot, "_journal.json"));
    const appended = journal.entries.filter(
      (entry) => entry.idx > REMOVAL_MIGRATION_IDX,
    );
    // The regression needs the shape that broke the old lookup: at least one
    // migration appended after the removal migration.
    expect(appended.length).toBeGreaterThan(0);
    expect(journal.entries.at(-1)?.idx).toBeGreaterThan(REMOVAL_MIGRATION_IDX);

    const removal = removalMigrationEntry(journal);
    expect(removal.idx).toBe(REMOVAL_MIGRATION_IDX);
    expect(removal.tag).toBe(REMOVAL_MIGRATION_TAG);
    // The selected entry is not the newest entry, and its SQL is the removal
    // migration's own file rather than the appended migration's.
    expect(removal).not.toBe(journal.entries.at(-1));
    const removalSql = readFileSync(
      join(migrationsRoot, `${removal.tag}.sql`),
      "utf8",
    );
    expect(removalSql.length).toBeGreaterThan(0);
    expect(removalSql).not.toBe(
      readFileSync(
        join(migrationsRoot, `${journal.entries.at(-1)!.tag}.sql`),
        "utf8",
      ),
    );

    // The pre-removal prefix is every earlier entry, and it excludes both the
    // removal migration and the appended migration.
    const prefix = journal.entries.filter(
      (entry) => entry.idx < REMOVAL_MIGRATION_IDX,
    );
    expect(prefix.map(({ idx }) => idx)).toEqual(
      Array.from({ length: REMOVAL_MIGRATION_IDX }, (_, index) => index),
    );

    // A journal that lost the removal entry, or that carries it twice, is
    // refused instead of silently selecting something else.
    expect(() =>
      removalMigrationEntry({
        entries: journal.entries.filter(
          (entry) => entry.idx !== REMOVAL_MIGRATION_IDX,
        ),
      }),
    ).toThrow(/expected exactly one/);
    expect(() =>
      removalMigrationEntry({
        entries: [...journal.entries, removal],
      }),
    ).toThrow(/expected exactly one/);
  });


  test("removes linked provider data without changing scenario runtime data", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const journal = readJson<DrizzleJournal>(
        join(metadataRoot, "_journal.json"),
      );
      const removal = removalMigrationEntry(journal);
      database.transaction(() => {
        for (const entry of journal.entries) {
          if (entry.idx < REMOVAL_MIGRATION_IDX) {
            applyMigration(database, entry.tag);
          }
        }
      })();

      for (const statement of rehearsalSeedStatements()) {
        database.exec(statement.sql);
      }

      database.transaction(() => applyMigration(database, removal.tag))();

      expect(
        database
          .query(
            "SELECT id FROM runtime_executions WHERE domain_kind = 'scenario'",
          )
          .all(),
      ).toEqual([{ id: "run-1" }]);
      expect(
        database
          .query(
            "SELECT vm.id FROM runtime_vms vm JOIN runtime_executions execution ON execution.id = vm.execution_id WHERE execution.domain_kind = 'scenario'",
          )
          .all(),
      ).toEqual([{ id: "runtime-vm-1" }]);
      expect(
        database
          .query(
            "SELECT artifact.id FROM runtime_artifacts artifact JOIN runtime_executions execution ON execution.id = artifact.execution_id WHERE execution.domain_kind = 'scenario'",
          )
          .all(),
      ).toEqual([{ id: "artifact-1" }]);
      expect(
        database.query("PRAGMA foreign_key_check").all(),
      ).toEqual([]);
      expect(
        database
          .query(
            "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'workshop_%' OR name LIKE 'provider_%' OR name IN ('gcp_connection_details', 'hetzner_connection_details'))",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close(false);
    }
  });

  test("revokes every live pre-cutover invite and retains an audit event", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const journal = readJson<DrizzleJournal>(
        join(metadataRoot, "_journal.json"),
      );
      for (const entry of journal.entries.slice(0, 2)) {
        applyMigration(database, entry.tag);
      }

      const createdAt = 1_000;
      const expiresAt = createdAt + 1_209_600_000;
      database
        .query(
          `INSERT INTO access_invite_codes (
            id, code_hash, code_prefix, kind, state, created_by, created_at,
            expires_at, version, updated_at
          ) VALUES (?, ?, ?, 'standard', 'pending', ?, ?, ?, 1, ?)`,
        )
        .run(
          "legacy-pending",
          "a".repeat(64),
          "legacy-A",
          "admin-test",
          createdAt,
          expiresAt,
          createdAt,
        );
      database
        .query(
          `INSERT INTO access_invite_codes (
            id, code_hash, code_prefix, kind, state, created_by, created_at,
            expires_at, lease_id, leased_at, lease_expires_at, version,
            updated_at
          ) VALUES (?, ?, ?, 'standard', 'leased', ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          "legacy-leased",
          "b".repeat(64),
          "legacy-B",
          "admin-test",
          createdAt,
          expiresAt,
          "legacy-lease",
          createdAt + 1_000,
          createdAt + 601_000,
          createdAt + 1_000,
        );
      database
        .query(
          `INSERT INTO access_invite_codes (
            id, code_hash, code_prefix, kind, state, created_by, created_at,
            expires_at, version, updated_at
          ) VALUES (?, ?, ?, 'bootstrap_admin', 'pending', null, ?, ?, 1, ?)`,
        )
        .run(
          "legacy-bootstrap",
          "c".repeat(64),
          "legacy-C",
          createdAt,
          expiresAt,
          createdAt,
        );

      // The invite gate was removed later; stop just before that migration so
      // the cutover's revocations can still be read back.
      const removalIndex = journal.entries.findIndex(({ tag }) =>
        readFileSync(join(migrationsRoot, `${tag}.sql`), "utf8").includes(
          "DROP TABLE `access_invite_codes`",
        ),
      );
      expect(removalIndex).toBeGreaterThan(2);
      for (const entry of journal.entries.slice(2, removalIndex)) {
        applyMigration(database, entry.tag);
      }

      expect(
        database
          .query(
            `SELECT
              id,
              state,
              lease_id AS leaseId,
              revoked_by AS revokedBy,
              revocation_reason AS reason,
              revoked_at IS NOT NULL AS hasRevokedAt,
              version,
              token_ciphertext AS tokenCiphertext,
              claim_expires_at AS claimExpiresAt
            FROM access_invite_codes
            ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "legacy-bootstrap",
          state: "revoked",
          leaseId: null,
          revokedBy: "system:invite-cutover",
          reason: "security_simplification_cutover",
          hasRevokedAt: 1,
          version: 2,
          tokenCiphertext: null,
          claimExpiresAt: null,
        },
        {
          id: "legacy-leased",
          state: "revoked",
          leaseId: null,
          revokedBy: "admin-test",
          reason: "security_simplification_cutover",
          hasRevokedAt: 1,
          version: 2,
          tokenCiphertext: null,
          claimExpiresAt: null,
        },
        {
          id: "legacy-pending",
          state: "revoked",
          leaseId: null,
          revokedBy: "admin-test",
          reason: "security_simplification_cutover",
          hasRevokedAt: 1,
          version: 2,
          tokenCiphertext: null,
          claimExpiresAt: null,
        },
      ]);
      expect(
        database
          .query(
            `SELECT invite_id AS inviteId, event_type AS eventType, reason
             FROM access_events
             ORDER BY invite_id`,
          )
          .all(),
      ).toEqual([
        {
          inviteId: "legacy-bootstrap",
          eventType: "invite.revoked",
          reason: "security_simplification_cutover",
        },
        {
          inviteId: "legacy-leased",
          eventType: "invite.revoked",
          reason: "security_simplification_cutover",
        },
        {
          inviteId: "legacy-pending",
          eventType: "invite.revoked",
          reason: "security_simplification_cutover",
        },
      ]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

      for (const entry of journal.entries.slice(removalIndex)) {
        applyMigration(database, entry.tag);
      }
      expect(
        database
          .query(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table'
               AND name IN ('access_allowlist', 'access_invite_codes', 'access_invite_removals')`,
          )
          .all(),
      ).toEqual([]);
      // The audit history outlives the invite tables.
      expect(
        database
          .query("SELECT count(*) AS count FROM access_events WHERE event_type = 'invite.revoked'")
          .get(),
      ).toEqual({ count: 3 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  test("drops the invite gate tables while invite rows still reference each other", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const journal = readJson<DrizzleJournal>(
        join(metadataRoot, "_journal.json"),
      );
      const removal = journal.entries.find(({ tag }) =>
        readFileSync(join(migrationsRoot, `${tag}.sql`), "utf8").includes(
          "DROP TABLE `access_invite_codes`",
        ),
      );
      if (!removal) throw new Error("the invite gate removal migration is missing");
      for (const entry of journal.entries.slice(0, removal.idx)) {
        applyMigration(database, entry.tag);
      }
      seedRedeemedInvite(database);

      // Production applies each migration as one D1 batch, a single
      // transaction, where the deferred foreign keys clear once every table
      // that references access_invite_codes is gone.
      database.transaction(() => applyMigration(database, removal.tag))();
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database.query("SELECT id FROM user WHERE id = 'member'").get(),
      ).toEqual({ id: "member" });
    } finally {
      database.close(false);
    }

    const undeferred = new Database(":memory:", { strict: true });
    try {
      undeferred.exec("PRAGMA foreign_keys = ON");
      const journal = readJson<DrizzleJournal>(
        join(metadataRoot, "_journal.json"),
      );
      const removal = journal.entries.find(({ tag }) =>
        readFileSync(join(migrationsRoot, `${tag}.sql`), "utf8").includes(
          "DROP TABLE `access_invite_codes`",
        ),
      )!;
      for (const entry of journal.entries.slice(0, removal.idx)) {
        applyMigration(undeferred, entry.tag);
      }
      seedRedeemedInvite(undeferred);
      const statements = readFileSync(
        join(migrationsRoot, `${removal.tag}.sql`),
        "utf8",
      )
        .split("--> statement-breakpoint")
        .map((entry) => entry.trim())
        .filter((entry) => entry && !entry.startsWith("PRAGMA defer_foreign_keys"));
      expect(() =>
        undeferred.transaction(() => {
          for (const statement of statements) undeferred.exec(statement);
        })(),
      ).toThrow(/FOREIGN KEY/u);
    } finally {
      undeferred.close(false);
    }
  });

  test("marks retryable builds with later replacements as history", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const journal = readJson<DrizzleJournal>(
        join(metadataRoot, "_journal.json"),
      );
      const supersessionIndex = journal.entries.findIndex(
        ({ tag }) => tag === "0012_supersede_replaced_build_failures",
      );
      expect(supersessionIndex).toBeGreaterThan(0);
      for (const entry of journal.entries.slice(0, supersessionIndex)) {
        applyMigration(database, entry.tag);
      }

      const bundleMeta = JSON.stringify({
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      });
      const insertBundle = database.query(
        `INSERT INTO image_build_bundles (
          rev, r2_key, meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      insertBundle.run("bundle-old", "old.tar.gz", bundleMeta, 1_000, 1_000);
      insertBundle.run("bundle-new", "new.tar.gz", bundleMeta, 2_000, 2_000);
      const insertBuild = database.query(
        `INSERT INTO image_builds (
          id, scenario_id, arch, rev, content_hash, status, phase, attempt,
          error, log_r2_key, created_at, updated_at
        ) VALUES (?, ?, 'x86_64', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      );
      insertBuild.run(
        "failed-old",
        "repair-routing",
        "bundle-old",
        "a".repeat(64),
        "failed",
        "failed",
        "QEMU failed",
        "builds/logs/failed-old.log",
        1_000,
        1_000,
      );
      insertBuild.run(
        "building-new",
        "repair-routing",
        "bundle-new",
        "b".repeat(64),
        "building",
        "building",
        null,
        "builds/logs/building-new.log",
        2_000,
        2_000,
      );
      insertBuild.run(
        "stale-old",
        "repair-routing",
        "bundle-old",
        "d".repeat(64),
        "stale",
        "building",
        "builder stopped reporting build progress",
        "builds/logs/stale-old.log",
        1_100,
        1_100,
      );
      insertBuild.run(
        "stale-uppercase",
        "repair-routing",
        "bundle-old",
        "e".repeat(64),
        "stale",
        "building",
        "SUPERSEDED BY BUNDLE bundle-other",
        "builds/logs/stale-uppercase.log",
        1_200,
        1_200,
      );
      insertBuild.run(
        "failed-current",
        "repair-storage",
        "bundle-new",
        "c".repeat(64),
        "failed",
        "failed",
        "current failure",
        "builds/logs/failed-current.log",
        2_000,
        2_000,
      );

      applyMigration(database, journal.entries[supersessionIndex]!.tag);
      applyMigration(database, journal.entries[supersessionIndex]!.tag);

      expect(
        database
          .query(
            `SELECT id, status, error, log_r2_key AS logR2Key,
                    updated_at AS updatedAt
             FROM image_builds
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "building-new",
          status: "building",
          error: null,
          logR2Key: "builds/logs/building-new.log",
          updatedAt: 2_000,
        },
        {
          id: "failed-current",
          status: "failed",
          error: "current failure",
          logR2Key: "builds/logs/failed-current.log",
          updatedAt: 2_000,
        },
        {
          id: "failed-old",
          status: "stale",
          error: "superseded by bundle bundle-new",
          logR2Key: "builds/logs/failed-old.log",
          updatedAt: 1_000,
        },
        {
          id: "stale-old",
          status: "stale",
          error: "superseded by bundle bundle-new",
          logR2Key: "builds/logs/stale-old.log",
          updatedAt: 1_100,
        },
        {
          id: "stale-uppercase",
          status: "stale",
          error: "superseded by bundle bundle-new",
          logR2Key: "builds/logs/stale-uppercase.log",
          updatedAt: 1_200,
        },
      ]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  test("reproduces the committed final schema from the typed schema", () => {
    const journal = readJson<DrizzleJournal>(join(metadataRoot, "_journal.json"));
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      tag: "0000_init",
      breakpoints: true,
    });
    expect(journal.entries.length).toBeGreaterThan(0);
    const finalEntry = journal.entries.at(-1);
    if (!finalEntry) throw new Error("Drizzle journal has no migrations");

    const temporaryRoot = mkdtempSync(join(tmpdir(), "intar-drizzle-generate-"));
    try {
      const environment = { ...process.env };
      delete environment.DRIZZLE_D1_HTTP;
      delete environment.CLOUDFLARE_ACCOUNT_ID;
      delete environment.CLOUDFLARE_DATABASE_ID;
      delete environment.CLOUDFLARE_D1_TOKEN;
      delete environment.CLOUDFLARE_API_TOKEN;
      environment.TMPDIR = temporaryRoot;
      environment.BUN_TMPDIR = temporaryRoot;

      const generated = spawnSync(
        "bunx",
        [
          "--bun",
          "drizzle-kit",
          "generate",
          "--dialect",
          "sqlite",
          "--schema",
          "./src/db/schema.ts",
          "--out",
          temporaryRoot,
          "--name",
          "init",
          "--breakpoints",
          "--prefix",
          "index",
        ],
        {
          cwd: webRoot,
          encoding: "utf8",
          env: environment,
        },
      );

      expect(generated.status, generated.stderr || generated.stdout).toBe(0);
      const committedSnapshot = normalizedSnapshot(
        readJson<Record<string, unknown>>(
          join(
            metadataRoot,
            `${String(finalEntry.idx).padStart(4, "0")}_snapshot.json`,
          ),
        ),
      );
      const regeneratedSnapshot = normalizedSnapshot(
        readJson<Record<string, unknown>>(
          join(temporaryRoot, "meta/0000_snapshot.json"),
        ),
      );
      expect(regeneratedSnapshot).toEqual(committedSnapshot);

      const regeneratedJournal = readJson<DrizzleJournal>(
        join(temporaryRoot, "meta/_journal.json"),
      );
      expect(regeneratedJournal.entries).toHaveLength(1);
      expect(regeneratedJournal.entries[0]).toMatchObject({
        idx: 0,
        tag: "0000_init",
        breakpoints: true,
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function seedRedeemedInvite(database: Database): void {
  const now = 1_000;
  database.exec(`
    INSERT INTO user (id, name, email) VALUES ('member', 'Member', 'member@example.test');
    INSERT INTO access_invite_codes (
      id, code_hash, code_prefix, kind, state, created_by, created_at, expires_at,
      lease_id, leased_at, lease_expires_at, redeemer_user_id,
      redeemer_github_account_id, redeemer_github_username, redeemed_at,
      version, updated_at
    ) VALUES (
      'invite', '${"d".repeat(64)}', 'invite-D', 'standard', 'redeemed', 'admin',
      ${now}, ${now + 1_209_600_000}, 'lease', ${now}, ${now + 600_000},
      'member', 'github-member', 'member', ${now}, 2, ${now}
    );
    INSERT INTO access_invite_removals (invite_id, invite_version, removed_by, removed_at)
      VALUES ('invite', 2, 'admin', ${now});
    INSERT INTO access_allowlist (
      user_id, state, github_account_id, github_username, source_invite_id,
      source_lease_id, grant_reason, granted_at
    ) VALUES ('member', 'active', 'github-member', 'member', 'invite', 'lease', 'invite', ${now});
  `);
}

function applyMigration(database: Database, tag: string): void {
  const migration = readFileSync(join(migrationsRoot, `${tag}.sql`), "utf8");
  for (const statement of migration
    .split("--> statement-breakpoint")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    database.exec(statement);
  }
}

function normalizedSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...snapshot,
    id: "<generated>",
    prevId: "<generated>",
  };
}
