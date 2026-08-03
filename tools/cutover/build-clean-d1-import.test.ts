import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCleanD1Import,
  CLEAN_D1_MIGRATION_NAME,
} from "./build-clean-d1-import";

const baseline = readFileSync(
  fileURLToPath(
    new URL(
      "../../apps/web/migrations/0000_clean_multicloud.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("clean D1 import builder", () => {
  it("wraps the single baseline with Wrangler's exact migration ledger", () => {
    const generated = buildCleanD1Import(baseline);

    expect(generated).toContain(
      'CREATE TABLE IF NOT EXISTS "d1_migrations"(',
    );
    expect(generated).toContain(baseline.trimEnd());
    expect(generated).toContain(
      `INSERT INTO "d1_migrations" (name) VALUES ('${CLEAN_D1_MIGRATION_NAME}');`,
    );
    expect(generated.endsWith("\n")).toBe(true);
    expect(generated.match(/INSERT INTO "d1_migrations"/g)).toHaveLength(1);
  });

  it("keeps the oversized baseline out of the remote query endpoint", () => {
    expect(Buffer.byteLength(baseline, "utf8")).toBeGreaterThan(100_000);
    const chunks = baseline
      .split("--> statement-breakpoint")
      .map((statement) => Buffer.byteLength(statement, "utf8"));
    expect(Math.max(...chunks)).toBeLessThan(100_000);
  });

  it("rejects empty, NUL-containing, and self-ledgering baselines", () => {
    expect(() => buildCleanD1Import("  \n")).toThrow(/must not be empty/);
    expect(() => buildCleanD1Import("SELECT 1;\0")).toThrow(/NUL/);
    expect(() =>
      buildCleanD1Import('CREATE TABLE "d1_migrations" (name TEXT);'),
    ).toThrow(/must not manage/);
  });
});
