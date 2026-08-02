import { describe, expect, it } from "vitest";
import { POLL_INTERVALS } from "./run-types";

describe("scenario run polling", () => {
  it("uses adaptive detail intervals and stops in terminal phases", () => {
    expect(POLL_INTERVALS.launching).toBe(750);
    expect(POLL_INTERVALS.booting).toBe(750);
    expect(POLL_INTERVALS.running).toBe(1_500);
    expect(POLL_INTERVALS.deleting).toBe(1_500);
    expect(POLL_INTERVALS.archiving).toBe(1_500);
    expect(POLL_INTERVALS.completed).toBe(false);
    expect(POLL_INTERVALS.failed).toBe(false);
  });
});
