import { describe, expect, it } from "vitest";
import {
  groupMyRunsByActivity,
  myRunsSummaryPollInterval,
  type MyRunEntry,
} from "./useMyRuns";

describe("groupMyRunsByActivity", () => {
  it("keeps foreground, background, and settled runs distinct", () => {
    const runs = [
      run("foreground", "run-a"),
      run("background", "run-b"),
      run("settled", "run-c"),
    ];

    const grouped = groupMyRunsByActivity(runs);

    expect(grouped.foreground.map((entry) => entry.runId)).toEqual(["run-a"]);
    expect(grouped.background.map((entry) => entry.runId)).toEqual(["run-b"]);
    expect(grouped.settled.map((entry) => entry.runId)).toEqual(["run-c"]);
  });
});

describe("myRunsSummaryPollInterval", () => {
  it("polls only while a run is active, faster during background cleanup", () => {
    expect(myRunsSummaryPollInterval(undefined)).toBe(false);
    expect(
      myRunsSummaryPollInterval({ activeCount: 0, activeRunId: null }),
    ).toBe(false);
    expect(
      myRunsSummaryPollInterval({ activeCount: 1, activeRunId: "run-a" }),
    ).toBe(30_000);
    expect(
      myRunsSummaryPollInterval({ activeCount: 1, activeRunId: null }),
    ).toBe(3_000);
  });
});

function run(activity: MyRunEntry["activity"], runId: string): MyRunEntry {
  return {
    runId,
    scenarioId: "scenario-1",
    scenarioName: "scenario-1",
    title: runId,
    difficulty: "easy",
    phase:
      activity === "settled"
        ? "completed"
        : activity === "background"
          ? "archiving"
          : "active_full",
    outcome: activity === "settled" ? "cancelled" : "in_progress",
    active: activity === "foreground",
    activity,
    deleteRequestedAt: activity === "foreground" ? null : 1,
    replayState: activity === "settled" ? "none" : "preparing",
    createdAt: 1,
    finishedAt: activity === "settled" ? 2 : null,
    solvedAt: null,
    solveDurationMs: null,
    solutionAssisted: false,
    hasReplay: false,
  };
}
