import { describe, expect, it } from "vitest";
import { planActiveRunStatus } from "./run-status-display";

const base = {
  activity: "foreground",
  outcome: "in_progress",
  phase: "running",
  phaseTitle: "Running",
  preparing: false,
} as const;

describe("planActiveRunStatus", () => {
  it("reads a live run as In progress, breathing", () => {
    expect(planActiveRunStatus(base)).toEqual({
      tone: "live",
      word: "In progress",
      pulse: true,
      frozen: false,
    });
  });

  it("takes word and tone from the preparing machine", () => {
    expect(
      planActiveRunStatus({ ...base, preparing: true, vmPhaseTitle: "Preparing" }),
    ).toMatchObject({ tone: "pending", word: "Preparing", pulse: true });
    expect(planActiveRunStatus({ ...base, preparing: true })?.word).toBe("Starting");
  });

  it("makes ending pending and failed still", () => {
    expect(planActiveRunStatus({ ...base, phase: "deleting" })).toMatchObject({
      tone: "pending",
      word: "Ending",
      pulse: true,
    });
    expect(
      planActiveRunStatus({ ...base, phase: "failed", phaseTitle: "Stopped" }),
    ).toMatchObject({ tone: "danger", word: "Stopped", pulse: false });
  });

  it("freezes the clock on Solved and calls saving Finishing", () => {
    expect(planActiveRunStatus({ ...base, phase: "solved" })).toMatchObject({
      tone: "success",
      frozen: true,
      pulse: false,
    });
    expect(planActiveRunStatus({ ...base, activity: "background" })?.word).toBe(
      "Finishing",
    );
  });

  it("leaves settled runs to their own tokens", () => {
    expect(
      planActiveRunStatus({ ...base, activity: "settled", outcome: "succeeded" }),
    ).toBeNull();
  });
});
