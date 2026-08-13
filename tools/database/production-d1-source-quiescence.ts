import { isNull } from "../../apps/web/node_modules/drizzle-orm/index.js";
import { drizzle } from "../../apps/web/node_modules/drizzle-orm/sqlite-proxy/index.js";
import {
  agentBootstrapTokens,
  hostActualState,
  workshopRegistryTokens,
} from "../../apps/web/src/db/schema.ts";
import type {
  D1Statement,
  D1StatementResult,
  D1Value,
  D1WriteClient,
} from "./d1-rest-client";
import { SOURCE_GATES } from "./production-d1-copy-manifest";

const QUIESCEABLE_GATE_IDS = new Set([
  "agent_bootstrap",
  "registry_tokens",
  "host_actual_state",
]);

export interface ProductionD1SourceQuiescenceEvidence {
  readonly version: 1;
  readonly mode: "dry-run" | "apply";
  readonly status: "quiescence_preflight_passed" | "source_quiesced";
  readonly accountId: string;
  readonly sourceDatabaseId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly quiescedAt: number;
  readonly before: readonly SourceGateCount[];
  readonly after: readonly SourceGateCount[] | null;
  readonly changes: {
    readonly agentBootstrapTokensRevoked: number;
    readonly workshopRegistryTokensRevoked: number;
    readonly hostActualStateDeleted: number;
  };
}

interface SourceGateCount {
  readonly id: string;
  readonly description: string;
  readonly count: number;
  readonly quiesceable: boolean;
}

export async function runProductionD1SourceQuiescence(input: {
  readonly mode: "dry-run" | "apply";
  readonly accountId: string;
  readonly sourceDatabaseId: string;
  readonly source: D1WriteClient;
  readonly now?: number;
}): Promise<ProductionD1SourceQuiescenceEvidence> {
  const startedAt = new Date().toISOString();
  const now = input.now ?? Date.now();
  const before = await readSourceGates(input.source, now);
  assertNoBlockingSourceGates(before);

  if (input.mode === "dry-run") {
    return {
      version: 1,
      mode: "dry-run",
      status: "quiescence_preflight_passed",
      accountId: input.accountId,
      sourceDatabaseId: input.sourceDatabaseId,
      startedAt,
      finishedAt: new Date().toISOString(),
      quiescedAt: now,
      before,
      after: null,
      changes: emptyChanges(),
    };
  }

  const statements = quiescenceStatements(now);
  const results = await input.source.batch(statements);
  if (results.length !== statements.length) {
    throw new Error(
      `source quiescence returned ${results.length} results for ${statements.length} statements`,
    );
  }
  const changes = {
    agentBootstrapTokensRevoked: requiredChanges(results[0], "agent bootstrap revocation"),
    workshopRegistryTokensRevoked: requiredChanges(
      results[1],
      "workshop registry token revocation",
    ),
    hostActualStateDeleted: requiredChanges(results[2], "host actual-state deletion"),
  };

  const after = await readSourceGates(input.source, now);
  const remaining = after.filter((gate) => gate.count !== 0);
  if (remaining.length > 0) {
    throw new Error(
      `source is not quiescent after capability retirement: ${formatGateCounts(remaining)}`,
    );
  }

  return {
    version: 1,
    mode: "apply",
    status: "source_quiesced",
    accountId: input.accountId,
    sourceDatabaseId: input.sourceDatabaseId,
    startedAt,
    finishedAt: new Date().toISOString(),
    quiescedAt: now,
    before,
    after,
    changes,
  };
}

function quiescenceStatements(now: number): readonly D1Statement[] {
  const db = drizzle(async () => ({ rows: [] }));
  return [
    compiledStatement(
      db
        .update(agentBootstrapTokens)
        .set({ revokedAt: now })
        .where(isNull(agentBootstrapTokens.revokedAt)),
    ),
    compiledStatement(
      db
        .update(workshopRegistryTokens)
        .set({ revokedAt: now })
        .where(isNull(workshopRegistryTokens.revokedAt)),
    ),
    compiledStatement(db.delete(hostActualState)),
  ];
}

function compiledStatement(query: {
  toSQL(): { sql: string; params: unknown[] };
}): D1Statement {
  const compiled = query.toSQL();
  return {
    sql: compiled.sql,
    params: compiled.params.map(asD1Value),
  };
}

function asD1Value(value: unknown): D1Value {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error(`Drizzle produced an unsupported D1 value: ${typeof value}`);
}

async function readSourceGates(
  source: D1WriteClient,
  now: number,
): Promise<readonly SourceGateCount[]> {
  const statements = SOURCE_GATES.map((gate) => ({
    sql: gate.sql,
    params: gate.usesCutoverTime ? [now] : [],
  }));
  const results = source.batchRead
    ? await source.batchRead(statements)
    : await Promise.all(
        statements.map((statement) =>
          source.query(statement.sql, statement.params),
        ),
      );
  if (results.length !== SOURCE_GATES.length) {
    throw new Error(
      `source gate read returned ${results.length} results for ${SOURCE_GATES.length} gates`,
    );
  }
  return SOURCE_GATES.map((gate, index) => ({
    id: gate.id,
    description: gate.description,
    count: countResult(results[index], gate.id),
    quiesceable: QUIESCEABLE_GATE_IDS.has(gate.id),
  }));
}

function assertNoBlockingSourceGates(gates: readonly SourceGateCount[]): void {
  const blocking = gates.filter((gate) => !gate.quiesceable && gate.count !== 0);
  if (blocking.length > 0) {
    throw new Error(
      `source has non-quiesceable activity: ${formatGateCounts(blocking)}`,
    );
  }
}

function countResult(result: D1StatementResult | undefined, gateId: string): number {
  const value = result?.rows[0]?.count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`source gate ${gateId} returned an invalid count`);
  }
  return value;
}

function requiredChanges(
  result: D1StatementResult | undefined,
  operation: string,
): number {
  if (
    typeof result?.changes !== "number" ||
    !Number.isSafeInteger(result.changes) ||
    result.changes < 0
  ) {
    throw new Error(`${operation} did not return a valid change count`);
  }
  return result.changes;
}

function formatGateCounts(gates: readonly SourceGateCount[]): string {
  return gates.map((gate) => `${gate.id}=${gate.count}`).join(", ");
}

function emptyChanges(): ProductionD1SourceQuiescenceEvidence["changes"] {
  return {
    agentBootstrapTokensRevoked: 0,
    workshopRegistryTokensRevoked: 0,
    hostActualStateDeleted: 0,
  };
}
