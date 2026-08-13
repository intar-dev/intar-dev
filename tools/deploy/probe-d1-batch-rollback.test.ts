import { describe, expect, it } from "vitest";
import type {
  D1Statement,
  D1StatementResult,
  D1WriteClient,
} from "../database/d1-rest-client";
import { proveD1BatchRollback } from "./probe-d1-batch-rollback";

class ProbeClient implements D1WriteClient {
  #userRows = 0;

  constructor(
    private readonly failureMode: "atomic" | "non-atomic" | "accepted",
  ) {}

  async query(
    sql: string,
    _params: readonly (string | number | boolean | null)[] = [],
  ): Promise<D1StatementResult> {
    return {
      rows: [{ count: sql.includes('FROM "user"') ? this.#userRows : 0 }],
      changes: 0,
    };
  }

  async batchRead(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return Promise.all(
      statements.map((statement) => this.query(statement.sql)),
    );
  }

  async batch(
    _statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    if (this.failureMode === "atomic") {
      throw new Error("UNIQUE constraint failed: user.id");
    }
    if (this.failureMode === "non-atomic") {
      this.#userRows = 1;
      throw new Error("UNIQUE constraint failed: user.id");
    }
    this.#userRows = 1;
    return [
      { rows: [], changes: 1 },
      { rows: [], changes: 1 },
    ];
  }
}

const input = {
  accountId: "account",
  databaseId: "11111111-2222-4333-8444-555555555555",
  probeId: "__d1_batch_rollback_probe_123",
  tableNames: ["organization", "user"],
} as const;

describe("remote D1 REST batch rollback probe", () => {
  it("accepts only a rejected batch whose first insert is absent", async () => {
    await expect(
      proveD1BatchRollback(new ProbeClient("atomic"), input),
    ).resolves.toMatchObject({
      version: 1,
      status: "rollback_proven",
      batchRequestRejected: true,
      probeRowsAfterFailure: 0,
      applicationRowsBefore: 0,
      applicationRowsAfter: 0,
      applicationTableCount: 2,
    });
  });

  it("rejects a failed batch that retained its first insert", async () => {
    await expect(
      proveD1BatchRollback(new ProbeClient("non-atomic"), input),
    ).rejects.toThrow("retained the first statement");
  });

  it("rejects a deliberately failing batch that reports success", async () => {
    await expect(
      proveD1BatchRollback(new ProbeClient("accepted"), input),
    ).rejects.toThrow("deliberately failing D1 REST batch was accepted");
  });
});
