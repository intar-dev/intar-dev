import { describe, expect, it } from "vitest";
import {
  runPhaseAcceptsBrowserTerminalSessions,
  runPhaseAcceptsTerminalSessions,
  type RunPhase,
} from "@/lib/run-state";

/**
 * The learner transport mounts hidden during boot, opens one browser route,
 * and holds the socket for the ready frame. That route is created pending and
 * exposes no endpoint or credential, so a booting run accepts it. Native SSH
 * keeps the ready-phase guard, because its create call carries the ready
 * endpoint.
 */
describe("terminal session run phases", () => {
  const readyPhases: RunPhase[] = [
    "active_partial",
    "active_full",
    "solved",
  ];
  const closedPhases: RunPhase[] = [
    "teardown_requested",
    "tearing_down",
    "archiving",
    "completed",
    "failed",
  ];

  it("accepts the prearmed browser route while the run is still booting", () => {
    expect(runPhaseAcceptsBrowserTerminalSessions("provisioning")).toBe(true);
    for (const phase of readyPhases) {
      expect(runPhaseAcceptsBrowserTerminalSessions(phase)).toBe(true);
    }
  });

  it("keeps the ready-phase guard for native SSH", () => {
    expect(runPhaseAcceptsTerminalSessions("provisioning")).toBe(false);
    expect(runPhaseAcceptsBrowserTerminalSessions("queued")).toBe(false);
    for (const phase of readyPhases) {
      expect(runPhaseAcceptsTerminalSessions(phase)).toBe(true);
      expect(runPhaseAcceptsBrowserTerminalSessions(phase)).toBe(true);
    }
  });

  it("closes every stopped, torn down, and failed phase to both modes", () => {
    for (const phase of closedPhases) {
      expect(runPhaseAcceptsBrowserTerminalSessions(phase)).toBe(false);
      expect(runPhaseAcceptsTerminalSessions(phase)).toBe(false);
    }
  });
});
