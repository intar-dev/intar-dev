import { describe, expect, it } from "vitest";
import { buildInitialRunState, type RunPhase } from "@/lib/run-state";
import {
  deriveScenarioRunActivity,
  deriveScenarioRunReplayState,
} from "./activity";

describe("scenario run activity", () => {
  it("separates foreground ownership from background cleanup", () => {
    expect(
      deriveScenarioRunActivity({
        activeKey: "user-1",
        phase: "active_full",
      }),
    ).toBe("foreground");
    expect(
      deriveScenarioRunActivity({
        activeKey: null,
        phase: "tearing_down",
      }),
    ).toBe("background");
    expect(
      deriveScenarioRunActivity({ activeKey: null, phase: "completed" }),
    ).toBe("settled");
  });
});

describe("scenario run replay state", () => {
  it("distinguishes not started, preparing, ready, none, and failed", () => {
    expect(deriveScenarioRunReplayState(state("active_full"))).toBe(
      "not_started",
    );
    expect(deriveScenarioRunReplayState(state("archiving"))).toBe("preparing");
    expect(
      deriveScenarioRunReplayState(
        state("completed", {
          hasRecording: true,
          sessionTimeline: [
            {
              index: 1,
              startTimestampMs: 10,
              durationMs: 20,
              exitCode: 0,
              castFilename: "session-01.cast",
              castArtifactId: "artifact-1",
              transcriptTruncated: false,
            },
          ],
        }),
      ),
    ).toBe("ready");
    expect(deriveScenarioRunReplayState(state("completed"))).toBe("none");
    expect(
      deriveScenarioRunReplayState(
        state("completed", { hasRecording: true, sessionTimeline: null }),
      ),
    ).toBe("failed");
  });
});

function state(
  phase: RunPhase,
  vmOverrides: Partial<
    ReturnType<typeof buildInitialRunState>["vms"][number]
  > = {},
) {
  const initial = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "web",
        runtimeVmName: "run-vm-1",
        hostname: "web",
        launchSummary: {
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  return {
    phase,
    vms: initial.vms.map((vm) => ({ ...vm, ...vmOverrides })),
  };
}
