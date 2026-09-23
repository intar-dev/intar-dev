import { describe, expect, it } from "vitest";
import { signupStatusFromCounts } from "@/lib/signup-status";
import { signupSpotsLine } from "./signup-spots";

describe("signupSpotsLine", () => {
  it.each([
    [50, 38, "12 of 50 spots left"],
    [50, 49, "1 of 50 spots left"],
    [1, 0, "1 of 1 spot left"],
    [1_000_000, 999_000, "1,000 of 1,000,000 spots left"],
  ])("counts open spots: limit %i, taken %i", (limit, taken, line) => {
    expect(signupSpotsLine(signupStatusFromCounts(limit, taken))).toBe(line);
  });

  it.each([
    [50, 50, "All 50 spots are taken · Members can still sign in"],
    [50, 62, "All 50 spots are taken · Members can still sign in"],
    [1, 1, "The only spot is taken · Members can still sign in"],
    [2_500, 2_500, "All 2,500 spots are taken · Members can still sign in"],
  ])("reports a full cap: limit %i, taken %i", (limit, taken, line) => {
    expect(signupSpotsLine(signupStatusFromCounts(limit, taken))).toBe(line);
  });

  it("reports closed sign-ups for a limit of 0", () => {
    expect(signupSpotsLine(signupStatusFromCounts(0, 0))).toBe(
      "Sign-ups are closed · Members can still sign in",
    );
    expect(signupSpotsLine(signupStatusFromCounts(0, 38))).toBe(
      "Sign-ups are closed · Members can still sign in",
    );
  });
});
