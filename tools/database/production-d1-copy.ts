import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  D1ReadClient,
  D1Row,
  D1Statement,
  D1StatementResult,
  D1Value,
  D1WriteClient,
} from "./d1-rest-client";
import {
  verifyGeneratedD1Schema,
} from "./generated-d1-schema";
import {
  APPLICATION_TABLES,
  COPY_TABLES,
  EXCLUDED_TABLES,
  SOURCE_GATES,
  TABLE_POLICIES,
  transformCopiedRow,
  type ApplicationTable,
  type CopyRow,
} from "./production-d1-copy-manifest";

const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_MAX_ROWS_PER_TABLE = 100_000;
const DEFAULT_MAX_TOTAL_ROWS = 500_000;
const MAX_PARAMETERS_PER_STATEMENT = 100;
const MAX_STATEMENTS_PER_REQUEST = 20;

interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
}

interface SnapshotIndex {
  name: string;
}

interface SnapshotForeignKey {
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
}

interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotForeignKey>;
}

interface DrizzleSnapshot {
  version: string;
  dialect: string;
  tables: Record<string, SnapshotTable>;
}

interface DrizzleJournal {
  entries: Array<{
    idx: number;
    when: number;
    tag: string;
  }>;
}

export interface CopyDigest {
  readonly count: number;
  readonly sha256: string;
}

export interface SchemaEvidence {
  readonly applicationTableCount: number;
  readonly explicitIndexCount: number;
  readonly migrationHash: string;
  readonly migrationCreatedAt: number;
  readonly foreignKeyViolations: number;
  readonly triggers: number;
  readonly views: number;
  readonly schemaSha256: string;
  readonly schemaObjectCount: number;
}

export interface ProductionD1CopyEvidence {
  readonly version: 1;
  readonly mode: "dry-run" | "apply";
  readonly status: "preflight_passed" | "copy_verified";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly cutoverAt: number;
  readonly accountId: string;
  readonly sourceDatabaseId: string;
  readonly targetDatabaseId: string;
  readonly bounds: {
    readonly pageSize: number;
    readonly maxRowsPerTable: number;
    readonly maxTotalRows: number;
    readonly maxParametersPerStatement: number;
    readonly maxStatementsPerRequest: number;
  };
  readonly schema: SchemaEvidence;
  readonly sourceGates: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly count: number;
  }>;
  readonly manifest: {
    readonly copied: ReadonlyArray<{
      readonly table: ApplicationTable;
      readonly reason: string;
      readonly transform: string | null;
    }>;
    readonly excluded: ReadonlyArray<{
      readonly table: ApplicationTable;
      readonly reason: string;
    }>;
  };
  readonly sourceBefore: Readonly<Record<string, CopyDigest>>;
  readonly sourceAfter: Readonly<Record<string, CopyDigest>> | null;
  readonly sourceAllBefore: Readonly<Record<string, CopyDigest>>;
  readonly sourceAllAfter: Readonly<Record<string, CopyDigest>> | null;
  readonly targetAfter: Readonly<Record<string, CopyDigest>> | null;
  readonly copiedRows: number;
}

export interface ProductionD1CopyOptions {
  readonly mode: "dry-run" | "apply";
  readonly accountId: string;
  readonly sourceDatabaseId: string;
  readonly targetDatabaseId: string;
  readonly source: D1ReadClient;
  readonly target: D1WriteClient;
  readonly cutoverAt?: number;
  readonly pageSize?: number;
  readonly maxRowsPerTable?: number;
  readonly maxTotalRows?: number;
  readonly artifacts?: DrizzleArtifacts;
}

export interface SourceUnchangedVerification {
  readonly version: 1;
  readonly status: "source_unchanged_after_target_activation";
  readonly sourceDatabaseId: string;
  readonly targetDatabaseId: string;
  readonly copyFinishedAt: string;
  readonly verifiedAt: string;
  readonly cutoverAt: number;
  readonly sourceAllExpected: Readonly<Record<ApplicationTable, CopyDigest>>;
  readonly sourceAllObserved: Readonly<Record<ApplicationTable, CopyDigest>>;
}

export interface DrizzleArtifacts {
  readonly snapshot: DrizzleSnapshot;
  readonly migrationHash: string;
  readonly migrationCreatedAt: number;
}

interface MaterializedCopy {
  readonly rows: ReadonlyMap<ApplicationTable, CopyRow[]>;
  readonly digests: Readonly<Record<string, CopyDigest>>;
  readonly totalRows: number;
}

interface SourceFingerprint {
  readonly digests: Readonly<Record<string, CopyDigest>>;
  readonly totalRows: number;
}

export async function runProductionD1Copy(
  options: ProductionD1CopyOptions,
): Promise<ProductionD1CopyEvidence> {
  const startedAt = new Date();
  const cutoverAt = options.cutoverAt ?? startedAt.getTime();
  const pageSize = boundedPositiveInteger(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    "pageSize",
    1_000,
  );
  const maxRowsPerTable = boundedPositiveInteger(
    options.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE,
    "maxRowsPerTable",
    1_000_000,
  );
  const maxTotalRows = boundedPositiveInteger(
    options.maxTotalRows ?? DEFAULT_MAX_TOTAL_ROWS,
    "maxTotalRows",
    2_000_000,
  );
  if (!Number.isSafeInteger(cutoverAt) || cutoverAt <= 0) {
    throw new Error("cutoverAt must be a positive safe integer");
  }
  if (options.sourceDatabaseId === options.targetDatabaseId) {
    throw new Error("source and target D1 database IDs must be different");
  }

  const artifacts = options.artifacts ?? loadCommittedDrizzleArtifacts();
  validateManifest(artifacts.snapshot);
  const schema = await verifyTargetSchema(options.target, artifacts);
  await verifySourceSchema(options.source, artifacts.snapshot);
  await verifyTargetFresh(options.target);
  const sourceGates = await assertSourceQuiescent(options.source, cutoverAt);

  const sourceAllBefore = await fingerprintSource({
    client: options.source,
    snapshot: artifacts.snapshot,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
  });

  const sourceBefore = await materializeCopy({
    client: options.source,
    snapshot: artifacts.snapshot,
    cutoverAt,
    transform: true,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
  });
  await assertSourceQuiescent(options.source, cutoverAt);

  if (options.mode === "dry-run") {
    return evidence({
      options,
      startedAt,
      cutoverAt,
      pageSize,
      maxRowsPerTable,
      maxTotalRows,
      schema,
      sourceGates,
      sourceBefore,
      sourceAfter: null,
      sourceAllBefore,
      sourceAllAfter: null,
      targetAfter: null,
    });
  }

  await insertMaterializedCopy(
    options.target,
    artifacts.snapshot,
    sourceBefore,
  );
  const postSchema = await verifyTargetSchema(options.target, artifacts);
  const excludedCounts = await countTables(
    options.target,
    EXCLUDED_TABLES.map(({ table }) => table),
  );
  const populatedExcluded = Object.entries(excludedCounts).filter(
    ([, count]) => count !== 0,
  );
  if (populatedExcluded.length > 0) {
    throw new Error(
      `target contains excluded rows: ${populatedExcluded.map(([table, count]) => `${table}=${count}`).join(", ")}`,
    );
  }

  const targetAfter = await materializeCopy({
    client: options.target,
    snapshot: artifacts.snapshot,
    cutoverAt,
    transform: false,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
  });
  assertDigestSetsEqual("source before vs target", sourceBefore, targetAfter);

  await assertSourceQuiescent(options.source, cutoverAt);
  const sourceAfter = await materializeCopy({
    client: options.source,
    snapshot: artifacts.snapshot,
    cutoverAt,
    transform: true,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
  });
  await assertSourceQuiescent(options.source, cutoverAt);
  assertDigestSetsEqual(
    "source changed during copy",
    sourceBefore,
    sourceAfter,
  );
  const sourceAllAfter = await fingerprintSource({
    client: options.source,
    snapshot: artifacts.snapshot,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
  });
  assertFingerprintEqual(sourceAllBefore, sourceAllAfter);
  await assertSourceQuiescent(options.source, cutoverAt);

  return evidence({
    options,
    startedAt,
    cutoverAt,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
    schema: postSchema,
    sourceGates,
    sourceBefore,
    sourceAfter,
    sourceAllBefore,
    sourceAllAfter,
    targetAfter,
  });
}

export async function verifySourceUnchangedAfterCopy(input: {
  readonly source: D1ReadClient;
  readonly sourceDatabaseId: string;
  readonly targetDatabaseId: string;
  readonly copyEvidence: unknown;
  readonly settle?: () => Promise<void>;
}): Promise<SourceUnchangedVerification> {
  const evidence = parseApplyEvidence(input.copyEvidence, {
    sourceDatabaseId: input.sourceDatabaseId,
    targetDatabaseId: input.targetDatabaseId,
  });
  const artifacts = loadCommittedDrizzleArtifacts();
  validateManifest(artifacts.snapshot);
  if (
    evidence.schema.migrationHash !== artifacts.migrationHash ||
    evidence.schema.migrationCreatedAt !== artifacts.migrationCreatedAt
  ) {
    throw new Error("copy evidence is not bound to the committed Drizzle baseline");
  }
  await verifySourceSchema(input.source, artifacts.snapshot);
  await assertSourceQuiescent(input.source, evidence.cutoverAt);
  const observed = await fingerprintSource({
    client: input.source,
    snapshot: artifacts.snapshot,
    pageSize: evidence.bounds.pageSize,
    maxRowsPerTable: evidence.bounds.maxRowsPerTable,
    maxTotalRows: evidence.bounds.maxTotalRows,
  });
  const expected: SourceFingerprint = {
    digests: evidence.sourceAllAfter,
    totalRows: Object.values(evidence.sourceAllAfter).reduce(
      (total, digest) => total + digest.count,
      0,
    ),
  };
  assertFingerprintEqual(expected, observed);
  await assertSourceQuiescent(input.source, evidence.cutoverAt);
  if (input.settle) await input.settle();
  const stable = await fingerprintSource({
    client: input.source,
    snapshot: artifacts.snapshot,
    pageSize: evidence.bounds.pageSize,
    maxRowsPerTable: evidence.bounds.maxRowsPerTable,
    maxTotalRows: evidence.bounds.maxTotalRows,
  });
  assertFingerprintEqual(expected, stable);
  await assertSourceQuiescent(input.source, evidence.cutoverAt);
  return {
    version: 1,
    status: "source_unchanged_after_target_activation",
    sourceDatabaseId: input.sourceDatabaseId,
    targetDatabaseId: input.targetDatabaseId,
    copyFinishedAt: evidence.finishedAt,
    verifiedAt: new Date().toISOString(),
    cutoverAt: evidence.cutoverAt,
    sourceAllExpected: evidence.sourceAllAfter,
    sourceAllObserved: stable.digests,
  };
}

export function loadCommittedDrizzleArtifacts(): DrizzleArtifacts {
  const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
  const snapshot = readJson<DrizzleSnapshot>(
    `${webRoot}migrations/meta/0000_snapshot.json`,
  );
  const journal = readJson<DrizzleJournal>(
    `${webRoot}migrations/meta/_journal.json`,
  );
  if (journal.entries.length !== 1 || journal.entries[0]?.tag !== "0000_init") {
    throw new Error(
      "production D1 copy requires the single generated 0000_init baseline",
    );
  }
  const migration = readFileSync(
    `${webRoot}migrations/${journal.entries[0].tag}.sql`,
    "utf8",
  );
  return {
    snapshot,
    migrationHash: createHash("sha256").update(migration).digest("hex"),
    migrationCreatedAt: journal.entries[0].when,
  };
}

export function validateManifest(snapshot: DrizzleSnapshot): void {
  if (snapshot.dialect !== "sqlite") {
    throw new Error(
      `expected a SQLite Drizzle snapshot, got ${snapshot.dialect}`,
    );
  }
  const snapshotTables = Object.keys(snapshot.tables).sort();
  const declaredTables = [...APPLICATION_TABLES].sort();
  assertStringSetsEqual(
    "typed schema vs D1 copy manifest",
    snapshotTables,
    declaredTables,
  );

  const policyTables = TABLE_POLICIES.map(({ table }) => table);
  if (new Set(policyTables).size !== policyTables.length) {
    throw new Error("D1 copy manifest contains duplicate table policies");
  }
  assertStringSetsEqual(
    "application tables vs copy/exclude policies",
    declaredTables,
    [...policyTables].sort(),
  );

  const copyPositions = new Map(
    COPY_TABLES.map(({ table }, index) => [table, index] as const),
  );
  for (const policy of COPY_TABLES) {
    const table = requiredTable(snapshot, policy.table);
    for (const foreignKey of Object.values(table.foreignKeys ?? {})) {
      const parentPosition = copyPositions.get(
        foreignKey.tableTo as ApplicationTable,
      );
      if (parentPosition === undefined || foreignKey.tableTo === policy.table) {
        continue;
      }
      const childPosition = copyPositions.get(policy.table)!;
      if (parentPosition > childPosition) {
        throw new Error(
          `copy order is not topological: ${policy.table} precedes parent ${foreignKey.tableTo}`,
        );
      }
    }
  }
}

async function verifyTargetSchema(
  target: D1ReadClient,
  artifacts: DrizzleArtifacts,
): Promise<SchemaEvidence> {
  const snapshot = artifacts.snapshot;
  const generatedSchema = await verifyGeneratedD1Schema(target);
  const objects = await rows(
    target,
    `SELECT type, name FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY type, name`,
  );
  const tableNames = objects
    .filter(({ type }) => type === "table")
    .map(({ name }) => stringValue(name, "sqlite_schema.name"));
  const expectedTables = [...APPLICATION_TABLES, "__drizzle_migrations"].sort();
  assertStringSetsEqual("target tables", tableNames.sort(), expectedTables);

  const triggers = objects.filter(({ type }) => type === "trigger").length;
  const views = objects.filter(({ type }) => type === "view").length;
  if (triggers !== 0 || views !== 0) {
    throw new Error(
      `target must have zero triggers and views (got ${triggers}/${views})`,
    );
  }

  for (const tableName of APPLICATION_TABLES) {
    const expected = requiredTable(snapshot, tableName);
    const actualColumns = await rows(
      target,
      `PRAGMA table_info(${quoteIdentifier(tableName)})`,
    );
    const expectedColumns = Object.values(expected.columns);
    if (actualColumns.length !== expectedColumns.length) {
      throw new Error(
        `${tableName} has ${actualColumns.length} columns; expected ${expectedColumns.length}`,
      );
    }
    for (const [index, expectedColumn] of expectedColumns.entries()) {
      const actual = actualColumns[index]!;
      if (
        actual.name !== expectedColumn.name ||
        String(actual.type).toLowerCase() !==
          expectedColumn.type.toLowerCase() ||
        numberValue(actual.notnull, `${tableName}.notnull`) !==
          Number(expectedColumn.notNull) ||
        Number(numberValue(actual.pk, `${tableName}.pk`) > 0) !==
          Number(expectedColumn.primaryKey)
      ) {
        throw new Error(
          `${tableName}.${expectedColumn.name} does not match the generated Drizzle snapshot`,
        );
      }
    }

    const actualForeignKeys = (
      await rows(
        target,
        `PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`,
      )
    )
      .map(
        (row) =>
          `${row.table}:${row.from}:${row.to}:${String(row.on_delete).toLowerCase()}:${String(row.on_update).toLowerCase()}`,
      )
      .sort();
    const expectedForeignKeys = Object.values(expected.foreignKeys ?? {})
      .flatMap((foreignKey) =>
        foreignKey.columnsFrom.map((column, index) =>
          `${foreignKey.tableTo}:${column}:${foreignKey.columnsTo[index]}:${foreignKey.onDelete ?? "no action"}:${foreignKey.onUpdate ?? "no action"}`.toLowerCase(),
        ),
      )
      .sort();
    assertStringSetsEqual(
      `${tableName} foreign keys`,
      actualForeignKeys,
      expectedForeignKeys,
    );
  }

  const expectedIndexes = Object.values(snapshot.tables)
    .flatMap((table) => Object.keys(table.indexes ?? {}))
    .sort();
  const actualIndexes = objects
    .filter(({ type }) => type === "index")
    .map(({ name }) => stringValue(name, "sqlite_schema.index"))
    .sort();
  assertStringSetsEqual(
    "target explicit indexes",
    actualIndexes,
    expectedIndexes,
  );

  const migrationRows = await rows(
    target,
    `SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  if (migrationRows.length !== 1) {
    throw new Error(
      `target must contain exactly one Drizzle migration marker, got ${migrationRows.length}`,
    );
  }
  const marker = migrationRows[0]!;
  if (
    marker.hash !== artifacts.migrationHash ||
    numberValue(marker.created_at, "__drizzle_migrations.created_at") !==
      artifacts.migrationCreatedAt
  ) {
    throw new Error("target Drizzle migration marker does not match 0000_init");
  }

  const foreignKeyViolations = (await rows(target, "PRAGMA foreign_key_check"))
    .length;
  if (foreignKeyViolations !== 0) {
    throw new Error(
      `target has ${foreignKeyViolations} foreign-key violations`,
    );
  }

  return {
    applicationTableCount: APPLICATION_TABLES.length,
    explicitIndexCount: expectedIndexes.length,
    migrationHash: artifacts.migrationHash,
    migrationCreatedAt: artifacts.migrationCreatedAt,
    foreignKeyViolations,
    triggers,
    views,
    schemaSha256: generatedSchema.schemaSha256,
    schemaObjectCount: generatedSchema.objects.length,
  };
}

async function verifySourceSchema(
  source: D1ReadClient,
  snapshot: DrizzleSnapshot,
): Promise<void> {
  const tableRows = await rows(
    source,
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
  );
  const sourceTables = new Set(
    tableRows.map(({ name }) => stringValue(name, "source table name")),
  );
  const allowedTables = new Set<string>([
    ...APPLICATION_TABLES,
    "d1_migrations",
    "__drizzle_migrations",
  ]);
  const unknownTables = [...sourceTables]
    .filter((table) => !allowedTables.has(table))
    .sort();
  if (unknownTables.length > 0) {
    throw new Error(
      `source contains unknown tables that are not modeled for copy: ${unknownTables.join(", ")}`,
    );
  }
  for (const policy of TABLE_POLICIES) {
    if (!sourceTables.has(policy.table)) {
      if (policy.action === "copy" && policy.optionalOnSource === true) {
        continue;
      }
      throw new Error(`source is missing required table ${policy.table}`);
    }
    const expectedColumns = Object.values(
      requiredTable(snapshot, policy.table).columns,
    ).map(({ name }) => name);
    const actualColumnRows = await rows(
      source,
      `PRAGMA table_xinfo(${quoteIdentifier(policy.table)})`,
    );
    const actualColumns = actualColumnRows.map(({ name, hidden }) => {
      if (numberValue(hidden, `${policy.table} source hidden`) !== 0) {
        throw new Error(`source table ${policy.table} has a hidden column`);
      }
      return stringValue(name, `${policy.table} source column`);
    });
    // Legacy D1 acquired some columns through ALTER TABLE, so physical
    // ordinals legitimately differ from a clean generated baseline. Every
    // copy query names its columns explicitly; require the exact name set
    // without treating historical order as schema drift.
    if (
      JSON.stringify(actualColumns.toSorted()) !==
      JSON.stringify(expectedColumns.toSorted())
    ) {
      throw new Error(
        `source table ${policy.table} columns do not exactly match the generated schema`,
      );
    }
  }
}

async function verifyTargetFresh(target: D1ReadClient): Promise<void> {
  const counts = await countTables(target, [...APPLICATION_TABLES]);
  const populated = Object.entries(counts).filter(([, count]) => count !== 0);
  if (populated.length > 0) {
    throw new Error(
      `target is not fresh: ${populated.map(([table, count]) => `${table}=${count}`).join(", ")}`,
    );
  }
}

async function assertSourceQuiescent(
  source: D1ReadClient,
  cutoverAt: number,
): Promise<ProductionD1CopyEvidence["sourceGates"]> {
  const statements = SOURCE_GATES.map((gate) => ({
    sql: gate.sql,
    params: gate.usesCutoverTime ? [cutoverAt] : [],
  }));
  const results = await readBatch(source, statements);
  const evidence = results.map((result, index) => {
    const gate = SOURCE_GATES[index]!;
    const count = countFromResult(result, `source gate ${gate.id}`);
    return { id: gate.id, description: gate.description, count };
  });
  const blocked = evidence.filter(({ count }) => count !== 0);
  if (blocked.length > 0) {
    throw new Error(
      `source is not quiescent: ${blocked.map(({ id, count }) => `${id}=${count}`).join(", ")}`,
    );
  }
  return evidence;
}

async function materializeCopy(input: {
  client: D1ReadClient;
  snapshot: DrizzleSnapshot;
  cutoverAt: number;
  transform: boolean;
  pageSize: number;
  maxRowsPerTable: number;
  maxTotalRows: number;
}): Promise<MaterializedCopy> {
  const rowsByTable = new Map<ApplicationTable, CopyRow[]>();
  const digests: Record<string, CopyDigest> = {};
  let totalRows = 0;

  const availableTables = new Set(
    (
      await rows(
        input.client,
        `SELECT name FROM sqlite_schema WHERE type = 'table'`,
      )
    ).map(({ name }) => stringValue(name, "table name")),
  );

  for (const policy of COPY_TABLES) {
    if (!availableTables.has(policy.table) && policy.optionalOnSource) {
      rowsByTable.set(policy.table, []);
      digests[policy.table] = canonicalDigest([], []);
      continue;
    }
    const table = requiredTable(input.snapshot, policy.table);
    const columns = Object.values(table.columns).map(({ name }) => name);
    const tableRows = await readAllRows(
      input.client,
      policy.table,
      columns,
      input.pageSize,
      input.maxRowsPerTable,
    );
    const copiedRows = input.transform
      ? tableRows.map((row) =>
          transformCopiedRow(policy.table, row, input.cutoverAt),
        )
      : tableRows;
    const orderedRows = policy.selfParentColumn
      ? topologicalRows(
          copiedRows,
          primaryKeyColumn(table),
          policy.selfParentColumn,
        )
      : copiedRows;
    totalRows += orderedRows.length;
    if (totalRows > input.maxTotalRows) {
      throw new Error(
        `copy contains more than maxTotalRows=${input.maxTotalRows}`,
      );
    }
    rowsByTable.set(policy.table, orderedRows);
    digests[policy.table] = canonicalDigest(orderedRows, columns);
  }

  return { rows: rowsByTable, digests, totalRows };
}

async function fingerprintSource(input: {
  client: D1ReadClient;
  snapshot: DrizzleSnapshot;
  pageSize: number;
  maxRowsPerTable: number;
  maxTotalRows: number;
}): Promise<SourceFingerprint> {
  const availableTables = new Set(
    (
      await rows(
        input.client,
        `SELECT name FROM sqlite_schema WHERE type = 'table'`,
      )
    ).map(({ name }) => stringValue(name, "table name")),
  );
  const digests: Record<string, CopyDigest> = {};
  let totalRows = 0;
  for (const tableName of APPLICATION_TABLES) {
    const table = requiredTable(input.snapshot, tableName);
    const columns = Object.values(table.columns).map(({ name }) => name);
    if (!availableTables.has(tableName)) {
      if (tableName !== "access_invite_removals") {
        throw new Error(`source fingerprint is missing ${tableName}`);
      }
      digests[tableName] = canonicalDigest([], columns);
      continue;
    }
    const tableRows = await readAllRows(
      input.client,
      tableName,
      columns,
      input.pageSize,
      input.maxRowsPerTable,
    );
    totalRows += tableRows.length;
    if (totalRows > input.maxTotalRows) {
      throw new Error(
        `source fingerprint contains more than maxTotalRows=${input.maxTotalRows}`,
      );
    }
    digests[tableName] = canonicalDigest(tableRows, columns);
  }
  return { digests, totalRows };
}

async function readAllRows(
  client: D1ReadClient,
  table: ApplicationTable,
  columns: readonly string[],
  pageSize: number,
  maxRows: number,
): Promise<CopyRow[]> {
  const result: CopyRow[] = [];
  let cursor = -1;
  for (;;) {
    const page = await rows(
      client,
      `SELECT rowid AS __copy_rowid, ${columns.map(quoteIdentifier).join(", ")}
       FROM ${quoteIdentifier(table)}
       WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [cursor, pageSize],
    );
    if (page.length === 0) break;
    for (const rawRow of page) {
      const rowid = numberValue(rawRow.__copy_rowid, `${table}.rowid`);
      if (!Number.isSafeInteger(rowid) || rowid <= cursor) {
        throw new Error(`${table} returned an invalid keyset cursor`);
      }
      cursor = rowid;
      const row: CopyRow = {};
      for (const column of columns) {
        const value = rawRow[column];
        if (!isCopyValue(value)) {
          throw new Error(`${table}.${column} has an unsupported value`);
        }
        row[column] = value;
      }
      result.push(row);
      if (result.length > maxRows) {
        throw new Error(`${table} exceeds maxRowsPerTable=${maxRows}`);
      }
    }
    if (page.length < pageSize) break;
  }
  return result;
}

async function insertMaterializedCopy(
  target: D1WriteClient,
  snapshot: DrizzleSnapshot,
  copy: MaterializedCopy,
): Promise<void> {
  for (const policy of COPY_TABLES) {
    const tableRows = copy.rows.get(policy.table) ?? [];
    if (tableRows.length === 0) continue;
    const columns = Object.values(
      requiredTable(snapshot, policy.table).columns,
    ).map(({ name }) => name);
    const rowsPerStatement = Math.max(
      1,
      Math.floor(MAX_PARAMETERS_PER_STATEMENT / columns.length),
    );
    const statements: D1Statement[] = [];
    for (
      let offset = 0;
      offset < tableRows.length;
      offset += rowsPerStatement
    ) {
      const chunk = tableRows.slice(offset, offset + rowsPerStatement);
      const placeholders = chunk
        .map(() => `(${columns.map(() => "?").join(", ")})`)
        .join(", ");
      statements.push({
        sql: `INSERT INTO ${quoteIdentifier(policy.table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${placeholders}`,
        params: chunk.flatMap((row) => columns.map((column) => row[column]!)),
      });
    }
    for (
      let offset = 0;
      offset < statements.length;
      offset += MAX_STATEMENTS_PER_REQUEST
    ) {
      const batch = statements.slice(
        offset,
        offset + MAX_STATEMENTS_PER_REQUEST,
      );
      const results = await target.batch(batch);
      if (results.length !== batch.length) {
        throw new Error(
          `${policy.table} target batch returned the wrong result count`,
        );
      }
    }
  }
}

async function countTables(
  client: D1ReadClient,
  tables: readonly ApplicationTable[],
): Promise<Record<string, number>> {
  const results = await readBatch(
    client,
    tables.map((table) => ({
      sql: `SELECT count(*) AS count FROM ${quoteIdentifier(table)}`,
    })),
  );
  return Object.fromEntries(
    results.map((result, index) => [
      tables[index]!,
      countFromResult(result, `${tables[index]} count`),
    ]),
  );
}

async function readBatch(
  client: D1ReadClient,
  statements: readonly D1Statement[],
): Promise<readonly D1StatementResult[]> {
  const all: D1StatementResult[] = [];
  for (
    let offset = 0;
    offset < statements.length;
    offset += MAX_STATEMENTS_PER_REQUEST
  ) {
    const chunk = statements.slice(offset, offset + MAX_STATEMENTS_PER_REQUEST);
    if (client.batchRead) {
      all.push(...(await client.batchRead(chunk)));
    } else {
      for (const statement of chunk) {
        all.push(await client.query(statement.sql, statement.params));
      }
    }
  }
  return all;
}

async function rows(
  client: D1ReadClient,
  sql: string,
  params: readonly D1Value[] = [],
): Promise<readonly D1Row[]> {
  return (await client.query(sql, params)).rows;
}

function canonicalDigest(
  tableRows: readonly CopyRow[],
  columns: readonly string[],
): CopyDigest {
  const rowHashes = tableRows
    .map((row) =>
      createHash("sha256")
        .update(JSON.stringify(columns.map((column) => row[column] ?? null)))
        .digest("hex"),
    )
    .sort();
  const digest = createHash("sha256");
  for (const rowHash of rowHashes) digest.update(rowHash).update("\n");
  return { count: tableRows.length, sha256: digest.digest("hex") };
}

function topologicalRows(
  tableRows: readonly CopyRow[],
  keyColumn: string,
  parentColumn: string,
): CopyRow[] {
  const byKey = new Map(
    tableRows.map((row) => [String(row[keyColumn]), row] as const),
  );
  const emitted = new Set<string>();
  const ordered: CopyRow[] = [];
  while (ordered.length < tableRows.length) {
    let progressed = false;
    for (const row of tableRows) {
      const key = String(row[keyColumn]);
      if (emitted.has(key)) continue;
      const parent = row[parentColumn];
      if (
        parent !== null &&
        byKey.has(String(parent)) &&
        !emitted.has(String(parent))
      ) {
        continue;
      }
      emitted.add(key);
      ordered.push(row);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        `cycle detected in ${keyColumn}/${parentColumn} copy order`,
      );
    }
  }
  return ordered;
}

function assertDigestSetsEqual(
  label: string,
  expected: MaterializedCopy,
  actual: MaterializedCopy,
): void {
  const mismatches = COPY_TABLES.filter(({ table }) => {
    const left = expected.digests[table];
    const right = actual.digests[table];
    return left?.count !== right?.count || left?.sha256 !== right?.sha256;
  }).map(({ table }) => table);
  if (mismatches.length > 0 || expected.totalRows !== actual.totalRows) {
    throw new Error(`${label}: digest mismatch in ${mismatches.join(", ")}`);
  }
}

function assertFingerprintEqual(
  expected: SourceFingerprint,
  actual: SourceFingerprint,
): void {
  const mismatches = APPLICATION_TABLES.filter((table) => {
    const left = expected.digests[table];
    const right = actual.digests[table];
    return left?.count !== right?.count || left?.sha256 !== right?.sha256;
  });
  if (mismatches.length > 0 || expected.totalRows !== actual.totalRows) {
    throw new Error(
      `source changed during copy: digest mismatch in ${mismatches.join(", ")}`,
    );
  }
}

function evidence(input: {
  options: ProductionD1CopyOptions;
  startedAt: Date;
  cutoverAt: number;
  pageSize: number;
  maxRowsPerTable: number;
  maxTotalRows: number;
  schema: SchemaEvidence;
  sourceGates: ProductionD1CopyEvidence["sourceGates"];
  sourceBefore: MaterializedCopy;
  sourceAfter: MaterializedCopy | null;
  sourceAllBefore: SourceFingerprint;
  sourceAllAfter: SourceFingerprint | null;
  targetAfter: MaterializedCopy | null;
}): ProductionD1CopyEvidence {
  return {
    version: 1,
    mode: input.options.mode,
    status:
      input.options.mode === "dry-run" ? "preflight_passed" : "copy_verified",
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cutoverAt: input.cutoverAt,
    accountId: input.options.accountId,
    sourceDatabaseId: input.options.sourceDatabaseId,
    targetDatabaseId: input.options.targetDatabaseId,
    bounds: {
      pageSize: input.pageSize,
      maxRowsPerTable: input.maxRowsPerTable,
      maxTotalRows: input.maxTotalRows,
      maxParametersPerStatement: MAX_PARAMETERS_PER_STATEMENT,
      maxStatementsPerRequest: MAX_STATEMENTS_PER_REQUEST,
    },
    schema: input.schema,
    sourceGates: input.sourceGates,
    manifest: {
      copied: COPY_TABLES.map(({ table, reason, transform }) => ({
        table,
        reason,
        transform: transform ?? null,
      })),
      excluded: EXCLUDED_TABLES.map(({ table, reason }) => ({ table, reason })),
    },
    sourceBefore: input.sourceBefore.digests,
    sourceAfter: input.sourceAfter?.digests ?? null,
    sourceAllBefore: input.sourceAllBefore.digests,
    sourceAllAfter: input.sourceAllAfter?.digests ?? null,
    targetAfter: input.targetAfter?.digests ?? null,
    copiedRows: input.sourceBefore.totalRows,
  };
}

interface ParsedApplyEvidence {
  readonly version: 1;
  readonly mode: "apply";
  readonly status: "copy_verified";
  readonly sourceDatabaseId: string;
  readonly targetDatabaseId: string;
  readonly finishedAt: string;
  readonly cutoverAt: number;
  readonly bounds: {
    readonly pageSize: number;
    readonly maxRowsPerTable: number;
    readonly maxTotalRows: number;
  };
  readonly schema: {
    readonly migrationHash: string;
    readonly migrationCreatedAt: number;
  };
  readonly sourceAllAfter: Readonly<Record<ApplicationTable, CopyDigest>>;
}

function parseApplyEvidence(
  value: unknown,
  expected: { sourceDatabaseId: string; targetDatabaseId: string },
): ParsedApplyEvidence {
  const record = objectValue(value, "copy evidence");
  if (
    record.version !== 1 ||
    record.mode !== "apply" ||
    record.status !== "copy_verified"
  ) {
    throw new Error("copy evidence must be a verified v1 apply result");
  }
  const sourceDatabaseId = stringValue(
    record.sourceDatabaseId as D1Value,
    "copy evidence sourceDatabaseId",
  );
  const targetDatabaseId = stringValue(
    record.targetDatabaseId as D1Value,
    "copy evidence targetDatabaseId",
  );
  if (
    sourceDatabaseId !== expected.sourceDatabaseId ||
    targetDatabaseId !== expected.targetDatabaseId ||
    sourceDatabaseId === targetDatabaseId
  ) {
    throw new Error("copy evidence database IDs do not match the verification request");
  }
  const sourceAllBefore = digestSet(record.sourceAllBefore, "sourceAllBefore");
  const sourceAllAfter = digestSet(record.sourceAllAfter, "sourceAllAfter");
  if (JSON.stringify(sourceAllBefore) !== JSON.stringify(sourceAllAfter)) {
    throw new Error("copy evidence did not prove a stable complete source");
  }
  const bounds = objectValue(record.bounds, "copy evidence bounds");
  const pageSize = boundedPositiveInteger(
    safeNumber(bounds.pageSize, "copy evidence pageSize"),
    "pageSize",
    1_000,
  );
  const maxRowsPerTable = boundedPositiveInteger(
    safeNumber(bounds.maxRowsPerTable, "copy evidence maxRowsPerTable"),
    "maxRowsPerTable",
    1_000_000,
  );
  const maxTotalRows = boundedPositiveInteger(
    safeNumber(bounds.maxTotalRows, "copy evidence maxTotalRows"),
    "maxTotalRows",
    2_000_000,
  );
  if (
    bounds.maxParametersPerStatement !== MAX_PARAMETERS_PER_STATEMENT ||
    bounds.maxStatementsPerRequest !== MAX_STATEMENTS_PER_REQUEST
  ) {
    throw new Error("copy evidence does not use the committed batch bounds");
  }
  const schema = objectValue(record.schema, "copy evidence schema");
  const migrationHash = stringValue(
    schema.migrationHash as D1Value,
    "copy evidence migrationHash",
  );
  if (!/^[0-9a-f]{64}$/u.test(migrationHash)) {
    throw new Error("copy evidence migrationHash must be lowercase SHA-256");
  }
  const migrationCreatedAt = safeNumber(
    schema.migrationCreatedAt,
    "copy evidence migrationCreatedAt",
  );
  const cutoverAt = safeNumber(record.cutoverAt, "copy evidence cutoverAt");
  const finishedAt = stringValue(
    record.finishedAt as D1Value,
    "copy evidence finishedAt",
  );
  if (Number.isNaN(Date.parse(finishedAt))) {
    throw new Error("copy evidence finishedAt must be an ISO timestamp");
  }
  return {
    version: 1,
    mode: "apply",
    status: "copy_verified",
    sourceDatabaseId,
    targetDatabaseId,
    finishedAt,
    cutoverAt,
    bounds: { pageSize, maxRowsPerTable, maxTotalRows },
    schema: { migrationHash, migrationCreatedAt },
    sourceAllAfter,
  };
}

function digestSet(
  value: unknown,
  label: string,
): Readonly<Record<ApplicationTable, CopyDigest>> {
  const record = objectValue(value, label);
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...APPLICATION_TABLES].sort();
  assertStringSetsEqual(label, actualKeys, expectedKeys);
  return Object.fromEntries(
    APPLICATION_TABLES.map((table) => {
      const digest = objectValue(record[table], `${label}.${table}`);
      const count = safeNonnegativeInteger(
        digest.count,
        `${label}.${table}.count`,
      );
      const sha256 = stringValue(
        digest.sha256 as D1Value,
        `${label}.${table}.sha256`,
      );
      if (count < 0 || !/^[0-9a-f]{64}$/u.test(sha256)) {
        throw new Error(`${label}.${table} is not a valid source digest`);
      }
      return [table, { count, sha256 }] as const;
    }),
  ) as Record<ApplicationTable, CopyDigest>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function requiredTable(
  snapshot: DrizzleSnapshot,
  table: ApplicationTable,
): SnapshotTable {
  const value = snapshot.tables[table];
  if (!value) throw new Error(`Drizzle snapshot is missing ${table}`);
  return value;
}

function primaryKeyColumn(table: SnapshotTable): string {
  const keys = Object.values(table.columns).filter(
    ({ primaryKey }) => primaryKey,
  );
  if (keys.length !== 1) {
    throw new Error(
      `${table.name} must have one primary key for self-ordering`,
    );
  }
  return keys[0]!.name;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`unsafe SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function countFromResult(result: D1StatementResult, label: string): number {
  const first = result.rows[0];
  if (!first || result.rows.length !== 1) {
    throw new Error(`${label} did not return exactly one row`);
  }
  const count = numberValue(first.count, label);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} returned an invalid count`);
  }
  return count;
}

function numberValue(value: D1Value | undefined, label: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${label} must be an integer`);
}

function stringValue(value: D1Value | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

function isCopyValue(value: unknown): value is CopyRow[string] {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function assertStringSetsEqual(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((value) => !actualSet.has(value));
    const extra = actual.filter((value) => !expectedSet.has(value));
    throw new Error(
      `${label} mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
}

function boundedPositiveInteger(
  value: number,
  name: string,
  upperBound: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > upperBound) {
    throw new Error(`${name} must be a positive integer <= ${upperBound}`);
  }
  return value;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
