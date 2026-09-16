import { describe, expect, it } from "vitest";
import {
  HOST_STATES,
  formatCheckedAt,
  formatLocation,
  formatLocationCount,
  formatMappedHostCount,
  formatPlaceLabel,
  formatStateCount,
} from "./format";

describe("fleet summary words", () => {
  it("counts the placed hosts without implying that they are all the hosts", () => {
    expect(formatMappedHostCount(1)).toBe("1 mapped host");
    expect(formatMappedHostCount(8)).toBe("8 mapped hosts");
  });

  it("counts places", () => {
    expect(formatLocationCount(1)).toBe("1 location");
    expect(formatLocationCount(7)).toBe("7 locations");
  });

  it("writes each state count, for one host and for many", () => {
    expect(formatStateCount("healthy", 1)).toBe("1 report on time");
    expect(formatStateCount("healthy", 5)).toBe("5 reports on time");
    expect(formatStateCount("degraded", 1)).toBe("1 report overdue");
    expect(formatStateCount("degraded", 2)).toBe("2 reports overdue");
    expect(formatStateCount("unknown", 1)).toBe("1 host with no report");
    expect(formatStateCount("unknown", 3)).toBe("3 hosts with no report");
  });

  it("names every state, so the legend and the filters agree", () => {
    for (const state of HOST_STATES) {
      expect(formatStateCount(state, 1)).not.toContain("times");
      expect(formatStateCount(state, 2)).toMatch(/^2 /u);
    }
  });
});

describe("fleet place words", () => {
  it("joins the city and the country", () => {
    expect(formatLocation("Nuremberg", "Germany")).toBe("Nuremberg, Germany");
  });

  it("names the part that is known", () => {
    expect(formatLocation(null, "Germany")).toBe("Germany");
    expect(formatLocation("Nuremberg", null)).toBe("Nuremberg");
    expect(formatLocation("  ", "  ")).toBe("Unknown location");
  });

  it("keeps the map label short", () => {
    expect(formatPlaceLabel("Nuremberg", "Germany")).toBe("Nuremberg");
    expect(formatPlaceLabel(null, "Germany")).toBe("Germany");
    expect(formatPlaceLabel(null, null)).toBe("Unknown location");
  });
});

describe("fleet snapshot time", () => {
  it("shows a short clock time, so the reader judges the age of the snapshot", () => {
    const nine = formatCheckedAt(Date.parse("2026-07-10T09:00:00.000Z"));
    const ten = formatCheckedAt(Date.parse("2026-07-10T10:00:00.000Z"));

    expect(nine).not.toBe(ten);
    expect(nine).toMatch(/\d/u);
    // The full timestamp would dominate the summary line.
    expect(nine.length).toBeLessThan(12);
  });
});
