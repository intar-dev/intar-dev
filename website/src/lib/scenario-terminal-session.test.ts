import { describe, expect, it } from "vitest";
import {
  runPhaseAcceptsTerminalSessions,
  type RunPhase,
} from "@/lib/run-state";

describe("scenario terminal session phase gate", () => {
  it.each([
    "active_partial",
    "active_full",
    "solved",
  ] satisfies RunPhase[])("accepts %s runs", (phase) => {
    expect(runPhaseAcceptsTerminalSessions(phase)).toBe(true);
  });

  it.each([
    "queued",
    "provisioning",
    "teardown_requested",
    "tearing_down",
    "archiving",
    "completed",
    "failed",
  ] satisfies RunPhase[])("rejects %s runs", (phase) => {
    expect(runPhaseAcceptsTerminalSessions(phase)).toBe(false);
  });
});
