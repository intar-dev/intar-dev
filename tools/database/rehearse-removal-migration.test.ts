import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { REMOVAL_MIGRATION_IDX } from "./apply-removal-migration";
import {
  prepareBaselineMigrations,
  rehearsalSeedStatements,
} from "./rehearse-removal-migration";

describe("removal migration D1 rehearsal", () => {
  test("seeds both retained and removed runtime domains", () => {
    const sql = rehearsalSeedStatements().map(({ sql }) => sql).join("\n");
    expect(sql).toContain("'scenario'");
    expect(sql).toContain("'workshop'");
    expect(sql).toContain("provider_credential_versions");
    expect(sql).not.toContain("DELETE FROM");
  });

  test("builds the baseline from the stream before the removal migration", () => {
    const destination = mkdtempSync(join(tmpdir(), "intar-baseline-test-"));
    try {
      prepareBaselineMigrations(destination);
      const journal = JSON.parse(
        readFileSync(join(destination, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string }> };
      // The baseline is exactly the prefix before the removal migration, so
      // the disposal rehearsal applies the removal migration itself next.
      expect(journal.entries.map(({ idx }) => idx)).toEqual(
        Array.from({ length: REMOVAL_MIGRATION_IDX }, (_, index) => index),
      );
      // A later appended migration is not part of the baseline stream either,
      // even though the removal migration is not the newest entry.
      expect(
        journal.entries.some(({ idx }) => idx >= REMOVAL_MIGRATION_IDX),
      ).toBe(false);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});
