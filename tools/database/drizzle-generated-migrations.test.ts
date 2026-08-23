import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

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

    expect(journal.dialect).toBe("sqlite");
    expect(journal.entries.map(({ tag }) => `${tag}.sql`)).toEqual(
      migrationFiles,
    );
    expect(
      journal.entries.map(
        ({ idx }) => `${String(idx).padStart(4, "0")}_snapshot.json`,
      ),
    ).toEqual(snapshotFiles);
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

      for (const entry of journal.entries.slice(2)) {
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
