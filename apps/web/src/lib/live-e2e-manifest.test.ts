import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../scripts/live-e2e";

describe("live E2E manifest loader", () => {
  it("accepts the generated V3 scenario manifest", () => {
    const fixture = readManifestFixture();

    expect(parseManifest(fixture, "scenario-manifest-v3.json")).toMatchObject({
      schema_version: 3,
      scenario_id: "broken-nginx",
    });
  });

  it("rejects the removed V2 catalog version", () => {
    const fixture = readManifestFixture();

    expect(() =>
      parseManifest(
        { ...fixture, schema_version: 2 },
        "scenario-manifest-v2.json",
      ),
    ).toThrow("manifest scenario-manifest-v2.json must use schema_version 3");
  });
});

function readManifestFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(
        "../generated/fixtures/catalog/scenario-manifest-v3.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}
