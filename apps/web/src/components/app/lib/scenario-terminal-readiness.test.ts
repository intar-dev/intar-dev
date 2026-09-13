import { describe, expect, it } from "vitest";
import {
  isTransportReadyFor,
  shouldRevealTerminal,
  shouldSendBenchmarkCommand,
  type TerminalTransportReport,
} from "./scenario-terminal-readiness";

const report = (
  overrides: Partial<TerminalTransportReport> = {},
): TerminalTransportReport => ({
  vmId: "vm-1",
  attempt: 1,
  ready: true,
  ...overrides,
});

describe("terminal transport readiness", () => {
  it("accepts the ready report of the selected VM", () => {
    expect(isTransportReadyFor(report(), "vm-1")).toBe(true);
  });

  it("ignores a report for another VM", () => {
    expect(isTransportReadyFor(report({ vmId: "vm-2" }), "vm-1")).toBe(false);
  });

  it("ignores a not-ready report and a missing report", () => {
    expect(isTransportReadyFor(report({ ready: false }), "vm-1")).toBe(false);
    expect(isTransportReadyFor(null, "vm-1")).toBe(false);
    expect(isTransportReadyFor(report(), null)).toBe(false);
  });
});

describe("terminal reveal", () => {
  it("reveals the shell when the gateway is ready but the status poll is not", () => {
    // The violation this change fixes: the socket was ready and hidden while
    // the page waited for the projection to report the same fact.
    expect(
      shouldRevealTerminal({
        transportReady: true,
        projectedReady: false,
        userWantsTerminal: true,
        runForeground: true,
      }),
    ).toBe(true);
  });

  it("keeps the projection path working when the transport is not ready", () => {
    expect(
      shouldRevealTerminal({
        transportReady: false,
        projectedReady: true,
        userWantsTerminal: true,
        runForeground: true,
      }),
    ).toBe(true);
  });

  it("never reveals without a readiness source", () => {
    expect(
      shouldRevealTerminal({
        transportReady: false,
        projectedReady: false,
        userWantsTerminal: true,
        runForeground: true,
      }),
    ).toBe(false);
  });

  it("honors a closed shell and a background run", () => {
    expect(
      shouldRevealTerminal({
        transportReady: true,
        projectedReady: true,
        userWantsTerminal: false,
        runForeground: true,
      }),
    ).toBe(false);
    expect(
      shouldRevealTerminal({
        transportReady: true,
        projectedReady: true,
        userWantsTerminal: true,
        runForeground: false,
      }),
    ).toBe(false);
  });
});

describe("benchmark command gate", () => {
  it("sends only when the handshake is current and the shell is visible", () => {
    expect(
      shouldSendBenchmarkCommand({
        gatewayReady: true,
        terminalVisible: true,
        connectionCurrent: true,
        commandAlreadySent: false,
      }),
    ).toBe(true);
  });

  it("never sends while the terminal is hidden", () => {
    // The primary metric violation: a hidden warm socket could complete the
    // nonce before the learner ever saw a terminal.
    expect(
      shouldSendBenchmarkCommand({
        gatewayReady: true,
        terminalVisible: false,
        connectionCurrent: true,
        commandAlreadySent: false,
      }),
    ).toBe(false);
  });

  it("never sends without the gateway ready frame", () => {
    expect(
      shouldSendBenchmarkCommand({
        gatewayReady: false,
        terminalVisible: true,
        connectionCurrent: true,
        commandAlreadySent: false,
      }),
    ).toBe(false);
  });

  it("never sends on a stale connection or a repeat pass", () => {
    expect(
      shouldSendBenchmarkCommand({
        gatewayReady: true,
        terminalVisible: true,
        connectionCurrent: false,
        commandAlreadySent: false,
      }),
    ).toBe(false);
    expect(
      shouldSendBenchmarkCommand({
        gatewayReady: true,
        terminalVisible: true,
        connectionCurrent: true,
        commandAlreadySent: true,
      }),
    ).toBe(false);
  });
});
