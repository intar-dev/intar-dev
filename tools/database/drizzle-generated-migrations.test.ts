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

  test("applies the generated baseline to an empty SQLite database", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const baseline = readFileSync(
        join(migrationsRoot, "0000_init.sql"),
        "utf8",
      );
      const statements = baseline
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);

      database.transaction(() => {
        for (const statement of statements) database.exec(statement);
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

  test("reproduces the committed baseline from the typed schema", () => {
    const journal = readJson<DrizzleJournal>(join(metadataRoot, "_journal.json"));
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      tag: "0000_init",
      breakpoints: true,
    });

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
      expect(readFileSync(join(temporaryRoot, "0000_init.sql"), "utf8")).toBe(
        readFileSync(join(migrationsRoot, "0000_init.sql"), "utf8"),
      );

      const committedSnapshot = normalizedSnapshot(
        readJson<Record<string, unknown>>(
          join(metadataRoot, "0000_snapshot.json"),
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
      expect(normalizedJournal(regeneratedJournal)).toEqual(
        normalizedJournal(journal),
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalizedSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return { ...snapshot, id: "<generated>" };
}

function normalizedJournal(journal: DrizzleJournal): DrizzleJournal {
  return {
    ...journal,
    entries: journal.entries.map((entry) => ({ ...entry, when: 0 })),
  };
}
