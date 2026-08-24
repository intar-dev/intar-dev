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
});
