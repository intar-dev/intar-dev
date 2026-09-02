import { describe, expect, test } from "bun:test";
import { removalMigrationBatch } from "./apply-removal-migration";

describe("removal migration D1 batch", () => {
  test("keeps the generated migration and ledger marker in one batch", () => {
    const batch = removalMigrationBatch();
    expect(batch[0]?.sql).toBe("PRAGMA defer_foreign_keys=ON;");
    expect(batch.at(-2)?.sql).toBe("PRAGMA defer_foreign_keys=OFF;");
    expect(batch.at(-1)?.sql).toBe(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    );
    expect(batch.at(-1)?.params?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.some(({ sql }) => sql.includes("runtime_executions"))).toBe(
      false,
    );
  });
});
