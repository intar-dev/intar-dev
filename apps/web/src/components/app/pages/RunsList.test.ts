import { describe, expect, it } from "vitest";
import type { MyRunEntry } from "../hooks/useMyRuns";
import { groupSettledRunsByScenario } from "./RunsList";

describe("settled run history", () => {
  it("clusters duplicate titles by scenario and retains numbered attempts", () => {
    const groups = groupSettledRunsByScenario([
      run({
        runId: "network-first",
        scenarioId: "network-repair",
        title: "Repair the service",
        createdAt: 100,
      }),
      run({
        runId: "storage-only",
        scenarioId: "storage-repair",
        title: "Repair the service",
        createdAt: 200,
      }),
      run({
        runId: "network-second",
        scenarioId: "network-repair",
        title: "Repair the service",
        createdAt: 300,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.title)).toEqual([
      "Repair the service",
      "Repair the service",
    ]);
    expect(groups[0]).toMatchObject({
      totalAttempts: 2,
      latest: { run: { runId: "network-second" }, attemptNumber: 2 },
      older: [{ run: { runId: "network-first" }, attemptNumber: 1 }],
    });
    expect(groups[1]).toMatchObject({
      totalAttempts: 1,
      latest: { run: { runId: "storage-only" }, attemptNumber: 1 },
      older: [],
    });
  });

  it("keeps matching scenario IDs from separate organizations separate", () => {
    const groups = groupSettledRunsByScenario([
      run({ runId: "public", scenarioId: "repair", createdAt: 100 }),
      run({
        runId: "team",
        scenarioId: "repair",
        organizationId: "org-platform",
        createdAt: 200,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.totalAttempts)).toEqual([1, 1]);
  });
});

function run(overrides: Partial<MyRunEntry> = {}): MyRunEntry {
  return {
    runId: "run-1",
    scenarioId: "scenario-1",
    organizationId: null,
    scenarioName: "scenario-1",
    title: "Repair the service",
    difficulty: "easy",
    phase: "completed",
    outcome: "succeeded",
    active: false,
    activity: "settled",
    deleteRequestedAt: null,
    replayState: "ready",
    createdAt: 1,
    finishedAt: 2,
    solvedAt: 2,
    solveDurationMs: 1_000,
    solutionAssisted: false,
    hasReplay: true,
    ...overrides,
  };
}
