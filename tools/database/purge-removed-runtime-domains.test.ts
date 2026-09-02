import { describe, expect, test } from "bun:test";
import type { D1StatementResult, D1WriteClient } from "./d1-rest-client";
import { purgeRemovedRuntimeDomains } from "./purge-removed-runtime-domains";

const result = (count: number, changes: number | null = null) => ({
  rows: [{ count }],
  changes,
}) satisfies D1StatementResult;

describe("removed runtime domain cleanup", () => {
  test("deletes only removed domains and preserves scenario counts", async () => {
    const writes: unknown[] = [];
    const client = {
      query: async () => result(0),
      batchRead: async () => [result(3), result(5), result(8), result(13), result(0)],
      batch: async (statements) => {
        writes.push(statements);
        return [result(0, 3), result(0), result(5), result(8), result(13)];
      },
    } satisfies D1WriteClient;

    await expect(purgeRemovedRuntimeDomains(client)).resolves.toMatchObject({
      removedBefore: 3,
      removed: 3,
      removedAfter: 0,
      scenarioExecutionsBefore: 5,
      scenarioExecutionsAfter: 5,
    });
    expect(writes).toHaveLength(1);
  });

  test("stops before deletion when a scenario depends on a removed domain", async () => {
    let wrote = false;
    const client = {
      query: async () => result(0),
      batchRead: async () => [result(3), result(5), result(8), result(13), result(1)],
      batch: async () => {
        wrote = true;
        return [];
      },
    } satisfies D1WriteClient;

    await expect(purgeRemovedRuntimeDomains(client)).rejects.toThrow(
      "scenario runtime history depends on a removed runtime domain",
    );
    expect(wrote).toBe(false);
  });
});
