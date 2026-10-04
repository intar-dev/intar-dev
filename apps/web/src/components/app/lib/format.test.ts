import { describe, expect, it } from "vitest";
import {
  formatClockSeconds,
  formatDate,
  formatMinutes,
  formatRelativeTime,
  sentenceCase,
} from "./format";

describe("format", () => {
  it("reads minutes in hours from 60", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(160)).toBe("2 h 40 min");
  });

  it("keeps the clock mm:ss past an hour", () => {
    expect(formatClockSeconds(65)).toBe("01:05");
    expect(formatClockSeconds(3_599)).toBe("59:59");
    expect(formatClockSeconds(4_512)).toBe("75:12");
  });

  it("steps relative times up to weeks, months and years in English", () => {
    const now = Date.now();
    const day = 86_400_000;
    expect(formatRelativeTime(now - 2 * day)).toBe("2 days ago");
    expect(formatRelativeTime(now - 14 * day)).toBe("2 weeks ago");
    expect(formatRelativeTime(now - 32 * day)).toBe("last month");
    expect(formatRelativeTime(now - 400 * day)).toBe("last year");
  });

  it("formats short dates and sentence case", () => {
    expect(formatDate(new Date(2026, 8, 12, 12).getTime())).toBe("12 Sep 2026");
    expect(sentenceCase("web")).toBe("Web");
    expect(sentenceCase("")).toBe("");
  });
});
