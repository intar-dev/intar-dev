import { describe, expect, it } from "vitest";
import { scenarioSourceCardVisible } from "@/components/app/pages/organization-detail/scenario-source";
import type { ScenarioSourceView } from "@/lib/scenario-sources";
import { formatScenarioResourceItems } from "./ScenarioRegistry";

describe("scenario source card", () => {
  const source = { repository: "intar-dev/scenarios" } as ScenarioSourceView;

  it("hides the public card until a repository is pinned or bound", () => {
    const card = { enabled: true, configured: false, appSlug: null };
    expect(scenarioSourceCardVisible({ ...card, source: null })).toBe(false);
    expect(
      scenarioSourceCardVisible({ ...card, configured: true, source: null }),
    ).toBe(true);
    expect(scenarioSourceCardVisible({ ...card, source })).toBe(true);
  });

  it("shows an organization card once the flag is on or a binding exists", () => {
    const card = { enabled: false, appSlug: null };
    expect(scenarioSourceCardVisible({ ...card, source: null })).toBe(false);
    expect(
      scenarioSourceCardVisible({ ...card, enabled: true, source: null }),
    ).toBe(true);
    expect(scenarioSourceCardVisible({ ...card, source })).toBe(true);
  });
});

describe("scenario registry resources", () => {
  it("formats aggregate CPU, RAM, and disk requirements", () => {
    expect(
      formatScenarioResourceItems({
        cpuMillis: 2_000,
        memoryMib: 2_048,
        diskMib: 16_384,
      }),
    ).toEqual(["2 CPU", "2 GiB RAM", "16 GiB disk"]);
  });
});
