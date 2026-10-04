import { describe, expect, it } from "vitest";
import { digitCells, rollDirection } from "./rolling-number";

describe("digitCells", () => {
  it("rolls only the place that changed", () => {
    expect(digitCells("48", "49")).toEqual([
      { char: "4", previous: null, order: 0 },
      { char: "9", previous: "8", order: 0 },
    ]);
  });

  it("rolls ones before tens on a carry", () => {
    expect(digitCells("49", "50")).toEqual([
      { char: "5", previous: "4", order: 1 },
      { char: "0", previous: "9", order: 0 },
    ]);
  });

  it("adds and drops places", () => {
    expect(digitCells("9", "10")).toEqual([
      { char: "1", previous: "", order: 1 },
      { char: "0", previous: "9", order: 0 },
    ]);
    expect(digitCells("10", "9")).toEqual([
      { char: "", previous: "1", order: 1 },
      { char: "9", previous: "0", order: 0 },
    ]);
  });

  it("leaves an unchanged number still", () => {
    expect(digitCells("12", "12").every((cell) => cell.previous === null)).toBe(
      true,
    );
  });
});

describe("rollDirection", () => {
  it("rolls up as a count grows and down as it shrinks", () => {
    expect(rollDirection("1", "2")).toBe(1);
    expect(rollDirection("2", "1")).toBe(-1);
    expect(rollDirection("9", "10")).toBe(1);
  });
});
