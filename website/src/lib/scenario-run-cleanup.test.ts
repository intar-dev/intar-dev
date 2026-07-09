import { describe, expect, it } from "vitest";
import {
  runVmsRequiringDesiredAbsence,
  scenarioRunPurgeBlockReason,
} from "@/lib/scenario-run-cleanup";

describe("scenario run cleanup", () => {
  it("marks every unfinished VM absent after a partial run failure", () => {
    const failed = { id: "vm-failed", phase: "failed" as const };
    const sibling = { id: "vm-running", phase: "ready" as const };
    const finished = { id: "vm-finished", phase: "completed" as const };

    expect(
      runVmsRequiringDesiredAbsence({ vms: [failed, sibling, finished] }),
    ).toEqual([failed, sibling]);
  });

  it("blocks purge until every VM teardown and artifact upload is complete", () => {
    expect(
      scenarioRunPurgeBlockReason(
        { vms: [{ id: "vm-1", phase: "failed" }] },
        [{ uploadStatus: "uploaded" }],
      ),
    ).toBe("vm_teardown_pending");

    expect(
      scenarioRunPurgeBlockReason(
        { vms: [{ id: "vm-1", phase: "completed" }] },
        [{ uploadStatus: "pending" }],
      ),
    ).toBe("artifact_upload_pending");

    expect(
      scenarioRunPurgeBlockReason(
        { vms: [{ id: "vm-1", phase: "completed" }] },
        [{ uploadStatus: "uploaded" }],
      ),
    ).toBeNull();
  });
});
