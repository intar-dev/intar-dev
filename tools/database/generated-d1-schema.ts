import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import type {
  D1ReadClient,
  D1Row,
  D1StatementResult,
  D1Value,
} from "./d1-rest-client";

export type GeneratedSchemaExpectation = "full" | "observed-ledger-prefix";

export interface CanonicalSchemaObject {
  readonly type: "table" | "index";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

export interface GeneratedMigrationMarker {
  readonly hash: string;
  readonly createdAt: number;
}

export interface GeneratedSchemaProof {
  readonly version: 1;
  readonly status: "exact_generated_schema_verified";
  readonly expectation: GeneratedSchemaExpectation;
  readonly appliedMigrationCount: number;
  readonly committedMigrationCount: number;
  readonly migrations: readonly GeneratedMigrationMarker[];
  readonly schemaSha256: string;
  readonly objects: readonly CanonicalSchemaObject[];
  readonly foreignKeyViolations: 0;
  readonly triggers: 0;
  readonly views: 0;
}

interface DrizzleJournal {
  readonly dialect: string;
  readonly entries: ReadonlyArray<{
    readonly idx: number;
    readonly when: number;
    readonly tag: string;
  }>;
}

interface GeneratedMigrationArtifact {
  readonly tag: string;
  readonly createdAt: number;
  readonly hash: string;
  readonly sql: string;
}

const WEB_ROOT = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const SCHEMA_QUERY = `SELECT type, name, tbl_name AS table_name, sql
  FROM sqlite_schema
  WHERE type IN ('table', 'index', 'view', 'trigger')
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_cf_%'
    AND sql IS NOT NULL
  ORDER BY type, name, tbl_name`;

export async function verifyGeneratedD1Schema(
  client: D1ReadClient,
  options: { expectation?: GeneratedSchemaExpectation } = {},
): Promise<GeneratedSchemaProof> {
  const expectation = options.expectation ?? "full";
  const committed = loadGeneratedMigrationArtifacts();
  const observedLedger = await rows(
    client,
    "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id",
  );
  if (observedLedger.length === 0) {
    throw new Error("D1 is not initialized by the committed Drizzle migration stream");
  }
  if (
    expectation === "full" &&
    observedLedger.length !== committed.length
  ) {
    throw new Error(
      `D1 has ${observedLedger.length} Drizzle markers; expected ${committed.length}`,
    );
  }
  if (observedLedger.length > committed.length) {
    throw new Error("D1 Drizzle ledger is not a prefix of the committed stream");
  }

  const observedMigrations = observedLedger.map((row, index) => {
    const expected = committed[index]!;
    const hash = stringValue(row.hash, `migration ${index} hash`);
    const createdAt = safeInteger(row.created_at, `migration ${index} created_at`);
    if (hash !== expected.hash || createdAt !== expected.createdAt) {
      throw new Error(`D1 Drizzle marker ${index} does not match ${expected.tag}`);
    }
    return { hash, createdAt };
  });

  const expectedObjects = generatedObjects(
    committed.slice(0, observedLedger.length),
  );
  const observedRows = await rows(client, SCHEMA_QUERY);
  const forbidden = observedRows.filter(
    (row) => row.type === "trigger" || row.type === "view",
  );
  if (forbidden.length > 0) {
    throw new Error(
      `D1 has forbidden custom schema objects: ${forbidden
        .map((row) => String(row.name))
        .join(", ")}`,
    );
  }
  const observedObjects = canonicalObjects(observedRows);
  assertCanonicalObjectsEqual(expectedObjects, observedObjects);

  const foreignKeyViolations = (await rows(client, "PRAGMA foreign_key_check"))
    .length;
  if (foreignKeyViolations !== 0) {
    throw new Error(`D1 has ${foreignKeyViolations} foreign-key violations`);
  }

  return {
    version: 1,
    status: "exact_generated_schema_verified",
    expectation,
    appliedMigrationCount: observedMigrations.length,
    committedMigrationCount: committed.length,
    migrations: observedMigrations,
    schemaSha256: schemaHash(observedObjects),
    objects: observedObjects,
    foreignKeyViolations: 0,
    triggers: 0,
    views: 0,
  };
}

export function expectedGeneratedD1Schema(
  appliedMigrationCount?: number,
): GeneratedSchemaProof {
  const committed = loadGeneratedMigrationArtifacts();
  const count = appliedMigrationCount ?? committed.length;
  if (!Number.isSafeInteger(count) || count <= 0 || count > committed.length) {
    throw new Error("appliedMigrationCount must select a nonempty migration prefix");
  }
  const selected = committed.slice(0, count);
  const objects = generatedObjects(selected);
  return {
    version: 1,
    status: "exact_generated_schema_verified",
    expectation: count === committed.length ? "full" : "observed-ledger-prefix",
    appliedMigrationCount: count,
    committedMigrationCount: committed.length,
    migrations: selected.map(({ hash, createdAt }) => ({ hash, createdAt })),
    schemaSha256: schemaHash(objects),
    objects,
    foreignKeyViolations: 0,
    triggers: 0,
    views: 0,
  };
}

function loadGeneratedMigrationArtifacts(): GeneratedMigrationArtifact[] {
  const journal = readJson<DrizzleJournal>(`${WEB_ROOT}migrations/meta/_journal.json`);
  if (journal.dialect !== "sqlite" || journal.entries.length === 0) {
    throw new Error("committed Drizzle journal must contain SQLite migrations");
  }
  return journal.entries.map((entry, position) => {
    if (entry.idx !== position || !Number.isSafeInteger(entry.when)) {
      throw new Error("committed Drizzle journal is not an ordered generated stream");
    }
    const sql = readFileSync(
      `${WEB_ROOT}migrations/${entry.tag}.sql`,
      "utf8",
    );
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
  });
}

function generatedObjects(
  migrations: readonly GeneratedMigrationArtifact[],
): CanonicalSchemaObject[] {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    // Match the pinned sqlite-proxy migrator: SQLiteDialect renders
    // sql.identifier("__drizzle_migrations") with double quotes.
    database.exec(
      'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n\tid SERIAL PRIMARY KEY,\n\thash text NOT NULL,\n\tcreated_at numeric\n)',
    );
    for (const migration of migrations) {
      for (const statement of migration.sql
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        database.exec(statement);
      }
      database
        .query(
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
        )
        .run(migration.hash, migration.createdAt);
    }
    return canonicalObjects(database.query(SCHEMA_QUERY).all() as D1Row[]);
  } finally {
    database.close(false);
  }
}

function canonicalObjects(rows: readonly D1Row[]): CanonicalSchemaObject[] {
  return rows.map((row, index) => {
    const type = stringValue(row.type, `schema object ${index} type`);
    if (type !== "table" && type !== "index") {
      throw new Error(`unexpected generated schema object type: ${type}`);
    }
    return {
      type,
      name: stringValue(row.name, `schema object ${index} name`),
      tableName: stringValue(
        row.table_name,
        `schema object ${index} table_name`,
      ),
      sql: canonicalSql(
        stringValue(row.sql, `schema object ${index} SQL`),
        stringValue(row.name, `schema object ${index} name`),
      ),
    };
  });
}

function assertCanonicalObjectsEqual(
  expected: readonly CanonicalSchemaObject[],
  actual: readonly CanonicalSchemaObject[],
): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  const mismatch = Math.max(expected.length, actual.length);
  for (let index = 0; index < mismatch; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) {
      throw new Error(
        `D1 schema differs from generated Drizzle SQL at object ${index}: expected ${expected[index]?.type ?? "<none>"}/${expected[index]?.name ?? "<none>"}, observed ${actual[index]?.type ?? "<none>"}/${actual[index]?.name ?? "<none>"}`,
      );
    }
  }
  throw new Error("D1 schema differs from generated Drizzle SQL");
}

function canonicalSql(sql: string, objectName: string): string {
  const normalized = sql.replaceAll("\r\n", "\n").trim();
  if (objectName !== "__drizzle_migrations") return normalized;

  // The ledger belongs to the pinned Drizzle migrator, not the generated
  // application stream. SQLite preserves renderer-only quote and indentation
  // choices in sqlite_schema, so normalize those while retaining its exact DDL.
  return normalized
    .replace(/[`"]__drizzle_migrations[`"]?/gu, "__drizzle_migrations")
    .replace(/\s+/gu, " ");
}

function schemaHash(objects: readonly CanonicalSchemaObject[]): string {
  return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

async function rows(client: D1ReadClient, sql: string): Promise<readonly D1Row[]> {
  return (await client.query(sql)).rows;
}

function stringValue(value: D1Value | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function safeInteger(value: D1Value | undefined, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export class BunSqliteD1ReadClient implements D1ReadClient {
  constructor(readonly database: Database) {}

  async query(
    sql: string,
    params: readonly D1Value[] = [],
  ): Promise<D1StatementResult> {
    const statement = this.database.query(sql);
    const rows = statement.all(...params) as D1Row[];
    return { rows, changes: null };
  }
}
