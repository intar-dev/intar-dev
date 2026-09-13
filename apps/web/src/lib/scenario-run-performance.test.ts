import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VM_BOOT_MARK_PREFIX,
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
    markPendingScenarioRunBootStage("repair-nginx", "start-accepted", 1_012);
    associateScenarioRunBootEvidence({
      runId: "run-1",
      scenarioId: "repair-nginx",
      reused: false,
      acceptedAt: 1_012,
    });
    for (const [stage, unixMs] of [
      ["terminal-session-request", 1_015],
      ["terminal-session", 1_017],
      ["terminal-websocket-open", 1_018],
    ] as const) {
      markScenarioRunBootStage({
        runId: "run-1",
        scenarioId: "repair-nginx",
        stage,
        unixMs,
      });
    }
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
        "start-accepted": 1_012,
        "terminal-session-request": 1_015,
        "terminal-session": 1_017,
        "terminal-websocket-open": 1_018,
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

  const CLICK_UNIX_MS = 1_000;

  /** Stubs the browser clock, storage, and cryptography the evidence reads. */
  function stubBrowser(options: { search?: string } = {}) {
    const storage = new MemoryStorage();
    vi.stubGlobal("window", {
      sessionStorage: storage,
      location: { search: options.search ?? "?bootBenchmark=1" },
    });
    vi.stubGlobal("performance", {
      timeOrigin: CLICK_UNIX_MS,
      now: () => 0,
      mark: vi.fn(),
      getEntriesByType: () => [],
      clearMarks: vi.fn(),
    });
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
      subtle: webcrypto.subtle,
    });
    return storage;
  }

  function benchmarkInput() {
    return {
      runId: "run-1",
      scenarioId: "repair-nginx",
      vmName: "vm-1",
      isCurrent: () => true,
    };
  }

  function pendingRecord(storage: Storage) {
    return storage.getItem(`${VM_BOOT_MARK_PREFIX}pending:repair-nginx`);
  }

  function armBenchmark(
    options: {
      search?: string;
      stage?: string;
      reused?: boolean;
      acceptedAt?: number;
    } = {},
  ) {
    stubBrowser(options);
    beginScenarioRunBootEvidence("repair-nginx", options.stage ?? "start-click");
    associateScenarioRunBootEvidence({
      runId: "run-1",
      scenarioId: "repair-nginx",
      reused: options.reused ?? false,
      // The default replayed run is accepted by this attempt, after the click.
      acceptedAt: options.acceptedAt ?? CLICK_UNIX_MS + 100,
    });
    markScenarioRunBootStage({
      runId: "run-1",
      scenarioId: "repair-nginx",
      stage: "terminal-connected",
    });
    return benchmarkInput();
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

  it("does not run without opt-in, a real click, and a run of this attempt", () => {
    for (const options of [
      { search: "" },
      { stage: "start-route" },
      { reused: true, acceptedAt: CLICK_UNIX_MS - 1 },
    ]) {
      expect(startScenarioRunBootBenchmark(armBenchmark(options))).toBeNull();
    }
  });

  it("keeps this attempt's nonce evidence when a lost response is replayed", () => {
    const storage = stubBrowser();
    // The learner clicks at 1 000, the admission commits at 1 120, and that
    // response is lost. The retry replays the run of that same attempt.
    beginScenarioRunBootEvidence("repair-nginx");
    markPendingScenarioRunBootStage(
      "repair-nginx",
      "start-request",
      CLICK_UNIX_MS + 10,
    );
    associateScenarioRunBootEvidence({
      runId: "run-1",
      scenarioId: "repair-nginx",
      reused: true,
      acceptedAt: CLICK_UNIX_MS + 120,
    });
    markScenarioRunBootStage({
      runId: "run-1",
      scenarioId: "repair-nginx",
      stage: "terminal-connected",
      unixMs: CLICK_UNIX_MS + 900,
    });

    // The click stays the start boundary, so the replay does not move the
    // clock, and the run keeps the nonce evidence of the fresh sample.
    expect(readScenarioRunBootEvidence("run-1")).toMatchObject({
      startUnixMs: CLICK_UNIX_MS,
      benchmark: true,
      terminalConnectedUnixMs: CLICK_UNIX_MS + 900,
    });
    expect(pendingRecord(storage)).toBeNull();
    expect(startScenarioRunBootBenchmark(benchmarkInput())).not.toBeNull();
  });

  it("refuses a run that predates the click and arms no nonce", () => {
    const storage = stubBrowser();
    beginScenarioRunBootEvidence("repair-nginx");
    associateScenarioRunBootEvidence({
      runId: "run-1",
      scenarioId: "repair-nginx",
      reused: true,
      acceptedAt: CLICK_UNIX_MS - 1,
    });

    // The run existed before the click, so it owns no evidence here and no
    // nonce is armed for it.
    expect(readScenarioRunBootEvidence("run-1")).toBeNull();
    expect(startScenarioRunBootBenchmark(benchmarkInput())).toBeNull();
    // The stale click record is dropped, so a later attempt cannot inherit a
    // clock that belongs to no run of its own.
    expect(pendingRecord(storage)).toBeNull();
  });

  it("refuses a reused response without a usable acceptance time", () => {
    stubBrowser();
    beginScenarioRunBootEvidence("repair-nginx");
    // A missing or malformed acceptance time arrives as a non-finite value,
    // which proves nothing about which attempt created the run.
    associateScenarioRunBootEvidence({
      runId: "run-1",
      scenarioId: "repair-nginx",
      reused: true,
      acceptedAt: Number.NaN,
    });

    expect(readScenarioRunBootEvidence("run-1")).toBeNull();
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
        reused: false,
        acceptedAt: 1,
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
