import { describe, expect, test } from "bun:test";
import { rehearsalSeedStatements } from "./rehearse-removal-migration";

describe("removal migration D1 rehearsal", () => {
  test("seeds both retained and removed runtime domains", () => {
    const sql = rehearsalSeedStatements().map(({ sql }) => sql).join("\n");
    expect(sql).toContain("'scenario'");
    expect(sql).toContain("'workshop'");
    expect(sql).toContain("provider_credential_versions");
    expect(sql).not.toContain("DELETE FROM");
  });
});
