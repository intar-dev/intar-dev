import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  associateScenarioRunBootEvidence,
  beginScenarioRunBootEvidence,
  markPendingScenarioRunBootStage,
  markScenarioRunBootStage,
  readScenarioRunBootEvidence,
  startScenarioRunBootBenchmark,
} from "./scenario-run-performance";

describe("scenario run boot evidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves the click time through acceptance and records first terminal milestones", () => {
    const storage = new MemoryStorage();
    const mark = vi.fn();
    vi.stubGlobal("window", { sessionStorage: storage });
    vi.stubGlobal("performance", {
      timeOrigin: 1_000,
      now: () => 10,
      mark,
      getEntriesByType: () => [],
      clearMarks: vi.fn(),
    });

    const startUnixMs = beginScenarioRunBootEvidence("repair-nginx");
    markPendingScenarioRunBootStage("repair-nginx", "start-request", 1_011);
    associateScenarioRunBootEvidence({
      runId: "run-1",
      scenarioId: "repair-nginx",
    });
    markScenarioRunBootStage({
      runId: "run-1",
      scenarioId: "repair-nginx",
      stage: "terminal-connected",
      unixMs: 1_020,
    });
    markScenarioRunBootStage({
      runId: "run-1",
      scenarioId: "repair-nginx",
      stage: "terminal-first-output",
      unixMs: 1_030,
    });
    markScenarioRunBootStage({
      runId: "run-1",
      scenarioId: "repair-nginx",
      stage: "terminal-connected",
      unixMs: 1_040,
    });

    expect(readScenarioRunBootEvidence("run-1")).toEqual({
      runId: "run-1",
      scenarioId: "repair-nginx",
      startUnixMs,
      terminalConnectedUnixMs: 1_020,
      terminalFirstOutputUnixMs: 1_030,
      stages: {
        "start-click": startUnixMs,
        "start-request": 1_011,
        "terminal-connected": 1_020,
        "terminal-first-output": 1_030,
      },
    });
    expect(mark).toHaveBeenCalledWith(
      "intar:vm-boot:start-click",
      expect.objectContaining({
        detail: expect.objectContaining({ runId: "run-1", scenarioId: "repair-nginx" }),
      }),
    );
  });

  function armBenchmark(options: { search?: string; stage?: string; reused?: boolean } = {}) {
    vi.stubGlobal("window", { sessionStorage: new MemoryStorage(), location: { search: options.search ?? "?bootBenchmark=1" } });
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555", subtle: webcrypto.subtle });
    beginScenarioRunBootEvidence("repair-nginx", options.stage ?? "start-click");
    associateScenarioRunBootEvidence({ runId: "run-1", scenarioId: "repair-nginx", reused: options.reused ?? false });
    markScenarioRunBootStage({ runId: "run-1", scenarioId: "repair-nginx", stage: "terminal-connected" });
    return { runId: "run-1", scenarioId: "repair-nginx", vmName: "vm-1", isCurrent: () => true };
  }

  it("logs one safe result only after the split remote nonce, never input echo", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const input = armBenchmark();
    const probe = startScenarioRunBootBenchmark(input)!;
    const nonce = "intar-bench-11111111222243338444555555555555";
    expect(probe.command).not.toContain(nonce);
    probe.observe(new TextEncoder().encode(probe.command));
    expect(log).not.toHaveBeenCalled();
    probe.observe(new TextEncoder().encode(`private terminal text ${nonce.slice(0, 17)}`));
    probe.observe(new TextEncoder().encode(nonce.slice(17)));
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    const output = JSON.parse(String(log.mock.calls[0]?.[1]));
    expect(output.firstCommand.outputObservedAfterCommand).toBe(true);
    expect(output.firstCommand.nonceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(output.firstCommand.successUnixMs).toBeGreaterThanOrEqual(output.firstCommand.startedUnixMs);
    expect(JSON.stringify(output)).not.toContain("private terminal");
    expect(JSON.stringify(output)).not.toContain(nonce);
    probe.observe(new TextEncoder().encode(nonce));
    expect(startScenarioRunBootBenchmark(input)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("does not run without opt-in, a real click, and a fresh accepted run", () => {
    for (const options of [{ search: "" }, { stage: "start-route" }, { reused: true }]) {
      expect(startScenarioRunBootBenchmark(armBenchmark(options))).toBeNull();
    }
  });

  it("rejects output from a disconnected generation and does not resend on reconnect", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let current = true;
    const input = { ...armBenchmark(), isCurrent: () => current };
    const probe = startScenarioRunBootBenchmark(input)!;
    current = false;
    probe.observe(new TextEncoder().encode("intar-bench-11111111222243338444555555555555"));
    await Promise.resolve();
    expect(log).not.toHaveBeenCalled();
    expect(startScenarioRunBootBenchmark({ ...input, isCurrent: () => true })).toBeNull();
  });

  it("rejects a wrong run identity and fails quietly without cryptography", () => {
    const input = armBenchmark();
    expect(startScenarioRunBootBenchmark({ ...input, scenarioId: "other" })).toBeNull();
    vi.stubGlobal("crypto", undefined);
    expect(startScenarioRunBootBenchmark(input)).toBeNull();
  });

  it("does not block a start when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("storage disabled");
      },
    });

    expect(() => beginScenarioRunBootEvidence("repair-nginx")).not.toThrow();
    expect(
      associateScenarioRunBootEvidence({
        runId: "run-1",
        scenarioId: "repair-nginx",
      }),
    ).toBeNull();
  });
});

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}
