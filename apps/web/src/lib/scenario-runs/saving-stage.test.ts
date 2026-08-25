import { describe, expect, it } from "vitest";
import {
  archiveStageRankForAgentStage,
  deriveScenarioRunSavingStage,
  lowestArchiveStageRank,
} from "./saving-stage";

describe("scenario run saving stage", () => {
  it("maps each real save milestone without exposing archive details", () => {
    expect(
      deriveScenarioRunSavingStage({ phase: "teardown_requested" }),
    ).toBe("save_requested");
    expect(deriveScenarioRunSavingStage({ phase: "tearing_down" })).toBe(
      "closing_workspace",
    );
    expect(
      deriveScenarioRunSavingStage({
        phase: "archiving",
        archiveStageRanks: [1],
      }),
    ).toBe("saving_files");
    expect(
      deriveScenarioRunSavingStage({
        phase: "archiving",
        archiveStageRanks: [2],
      }),
    ).toBe("preparing_replay");
    expect(
      deriveScenarioRunSavingStage({
        phase: "archiving",
        archiveStageRanks: [3],
      }),
    ).toBe("finalizing_recap");
  });

  it("holds a multi-machine run at the slowest reported milestone", () => {
    expect(lowestArchiveStageRank([3, 1, 2])).toBe(1);
    expect(
      deriveScenarioRunSavingStage({
        phase: "archiving",
        archiveStageRanks: [3, 1, 2],
      }),
    ).toBe("saving_files");
  });

  it("uses the coarse lifecycle for missing ranks and never shows saving elsewhere", () => {
    expect(lowestArchiveStageRank([2, null])).toBeNull();
    expect(lowestArchiveStageRank([])).toBeNull();
    expect(
      deriveScenarioRunSavingStage({
        phase: "archiving",
        archiveStageRanks: [2, null],
      }),
    ).toBe("closing_workspace");
    expect(deriveScenarioRunSavingStage({ phase: "active_full" })).toBeNull();
    expect(deriveScenarioRunSavingStage({ phase: "completed" })).toBeNull();
    expect(deriveScenarioRunSavingStage({ phase: "failed" })).toBeNull();
  });

  it("maps a replay skip to the same completed work milestone", () => {
    expect(archiveStageRankForAgentStage("raw_files_saved")).toBe(2);
    expect(archiveStageRankForAgentStage("replay_prepared")).toBe(3);
    expect(archiveStageRankForAgentStage("replay_skipped")).toBe(3);
  });
});
