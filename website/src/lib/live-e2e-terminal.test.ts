import { describe, expect, it } from "vitest";
import {
  advanceTerminalProbeLifecycle,
  inspectReplayProbeOutput,
  initialTerminalProbeLifecycle,
  terminalProbeCommand,
  type TerminalProbeLifecycleEvent,
} from "../../scripts/live-e2e-terminal";

describe("live E2E terminal lifecycle", () => {
  it("waits for marker, successful exit, and server close", () => {
    const markerOnly = advance([event("marker")]);
    expect(markerOnly.result).toEqual({ status: "pending" });

    const exitSeen = advance([event("marker"), event("exit", 0)]);
    expect(exitSeen.result).toEqual({ status: "pending" });

    const closed = advance([
      event("marker"),
      event("exit", 0),
      event("close"),
    ]);
    expect(closed.result).toEqual({ status: "passed" });
  });

  it("rejects incomplete and failed terminal shutdowns", () => {
    expect(advance([event("close")]).result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("before the probe marker"),
    });
    expect(advance([event("marker"), event("close")]).result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("without an exit acknowledgement"),
    });
    expect(
      advance([event("marker"), event("exit", 255), event("close")]).result,
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("code 255"),
    });
  });

  it("ends the probe with a natural successful shell exit", () => {
    expect(terminalProbeCommand("MARKER", [], [])).toMatch(
      /printf 'MARKER_END\\n'\nexit 0\n$/,
    );
  });

  it("finds executed markers split across asciicast output events", () => {
    const cast = [
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 0 }),
      JSON.stringify([0.1, "o", "MARKER_BEG"]),
      JSON.stringify([0.2, "o", "IN\r\nprobe output\r\nMARKER_"]),
      JSON.stringify([0.3, "o", "END\r\n"]),
    ].join("\n");

    expect(inspectReplayProbeOutput(cast, "MARKER")).toEqual({
      beginSeen: true,
      endSeen: true,
    });
  });
});

function advance(events: TerminalProbeLifecycleEvent[]) {
  return events.reduce(
    advanceTerminalProbeLifecycle,
    initialTerminalProbeLifecycle(),
  );
}

function event(type: "marker" | "close"): TerminalProbeLifecycleEvent;
function event(type: "exit", code: number): TerminalProbeLifecycleEvent;
function event(
  type: "marker" | "exit" | "close",
  code?: number,
): TerminalProbeLifecycleEvent {
  return type === "exit" ? { type, code: code ?? 0 } : { type };
}
