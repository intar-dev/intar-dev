import { describe, expect, it } from "vitest";
import { isSafeScenarioId } from "@/lib/scenario-id";

describe("scenario id validation", () => {
  it("accepts only bounded path-safe scenario ids", () => {
    expect(isSafeScenarioId("broken-nginx")).toBe(true);
    expect(isSafeScenarioId("workshop_cluster.1")).toBe(true);
    expect(isSafeScenarioId("a".repeat(128))).toBe(true);

    expect(isSafeScenarioId("")).toBe(false);
    expect(isSafeScenarioId(".")).toBe(false);
    expect(isSafeScenarioId("..")).toBe(false);
    expect(isSafeScenarioId("../broken-nginx")).toBe(false);
    expect(isSafeScenarioId("broken/nginx")).toBe(false);
    expect(isSafeScenarioId("broken nginx")).toBe(false);
    expect(isSafeScenarioId("a".repeat(129))).toBe(false);
  });
});
