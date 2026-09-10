import { afterEach, describe, expect, it, vi } from "vitest";
import {
  associateScenarioRunBootEvidence,
  beginScenarioRunBootEvidence,
  markPendingScenarioRunBootStage,
  markScenarioRunBootStage,
  readScenarioRunBootEvidence,
} from "./scenario-run-performance";

describe("scenario run boot evidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
