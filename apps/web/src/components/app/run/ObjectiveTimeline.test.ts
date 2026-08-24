import { describe, expect, it } from "vitest";
import { toTimelineEvents } from "./ObjectiveTimeline";

describe("objective timeline copy", () => {
  it("does not expose stored probe labels", () => {
    const events = toTimelineEvents(
      [
        {
          id: "snapshot-1",
          vmId: "vm-1",
          runtimeVmName: "web",
          observedAt: 1_000,
          probes: [
            {
              id: "boot-network",
              label: "raw-boot-probe",
              kind: "service",
              phase: "boot",
              status: "pass",
            },
            {
              id: "deployment-ready",
              label: "raw-scenario-probe",
              kind: "command_json_path",
              phase: "scenario",
              status: "fail",
            },
          ],
        },
      ],
      [
        {
          probeName: "deployment-ready",
          vmName: "web",
          label: "raw-objective-label",
          title: "Restore the web rollout",
          bodyMarkdown: null,
          hintCount: 0,
        },
      ],
    );

    expect(events[0]?.changes.map((change) => change.label)).toEqual([
      "Startup check 1",
      "Restore the web rollout",
    ]);
    expect(JSON.stringify(events)).not.toContain("raw-");
  });

  it("records only changes between the two visible probe results", () => {
    const rows = [
      objectiveSnapshot("pending", 1_000),
      objectiveSnapshot("fail", 2_000),
      objectiveSnapshot("unknown", 3_000),
      objectiveSnapshot("pass", 4_000),
    ];

    const events = toTimelineEvents(rows, []);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      observedAt: 4_000,
      changes: [{ from: "unknown", to: "pass" }],
    });
  });

  it("records verifier outages without adding a third probe result", () => {
    const events = toTimelineEvents(
      [
        objectiveSnapshot("fail", 1_000),
        {
          ...objectiveSnapshot("error", 2_000),
          verificationUnavailable: true,
        },
      ],
      [],
    );

    expect(events[0]).toMatchObject({
      observedAt: 2_000,
      changes: [],
      verificationUnavailable: true,
    });
  });
});

function objectiveSnapshot(status: string, observedAt: number) {
  return {
    id: `snapshot-${observedAt}`,
    vmId: "vm-1",
    runtimeVmName: "web",
    observedAt,
    probes: [
      {
        id: "deployment-ready",
        label: "Deployment ready",
        kind: "command_json_path",
        phase: "scenario" as const,
        status,
      },
    ],
  };
}
