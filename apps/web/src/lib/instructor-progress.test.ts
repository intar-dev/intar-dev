import { describe, expect, it } from "vitest";
import { bestSolveDuration, cellStatus } from "./progress-status";

function run(input: {
  active?: boolean;
  solvedAt?: number | null;
  assisted?: boolean;
  duration?: number | null;
}) {
  return {
    runId: "r",
    active: input.active ?? false,
    solvedAt: input.solvedAt ?? null,
    solutionAssisted: input.assisted ?? false,
    solveDurationMs: input.duration ?? null,
    createdAt: 0,
  };
}

describe("cellStatus", () => {
  it("not_started with no runs", () => {
    expect(cellStatus([])).toBe("not_started");
  });

  it("in_progress with an active unsolved run", () => {
    expect(cellStatus([run({ active: true })])).toBe("in_progress");
  });

  it("not_started when only abandoned unsolved runs exist", () => {
    expect(cellStatus([run({})])).toBe("not_started");
  });

  it("solved beats in_progress", () => {
    expect(cellStatus([run({ active: true }), run({ solvedAt: 5 })])).toBe(
      "solved",
    );
  });

  it("assisted when every solve used the solution", () => {
    expect(cellStatus([run({ solvedAt: 5, assisted: true })])).toBe("assisted");
  });

  it("a clean solve outranks an assisted one", () => {
    expect(
      cellStatus([
        run({ solvedAt: 5, assisted: true }),
        run({ solvedAt: 9, assisted: false }),
      ]),
    ).toBe("solved");
  });
});

describe("bestSolveDuration", () => {
  it("returns the fastest solve", () => {
    expect(
      bestSolveDuration([
        run({ solvedAt: 1, duration: 300 }),
        run({ solvedAt: 2, duration: 120 }),
      ]),
    ).toBe(120);
  });

  it("null when nothing solved", () => {
    expect(bestSolveDuration([run({ active: true })])).toBeNull();
  });
});
