import { describe, expect, it } from "vitest";
import type { WorkshopTimer } from "./types";
import {
  workshopTimerClientClockOffsetMs,
  workshopTimerRemainingMs,
} from "./WorkshopTimer";

describe("WorkshopTimer server clock", () => {
  it("uses the server observation anchor despite client clock skew", () => {
    const timer: WorkshopTimer = {
      observedAt: 100_000,
      startedAt: 40_000,
      endsAt: 160_000,
      pausedAt: null,
      remainingMs: null,
    };
    const skewedClientNow = 700_000;
    const offset = workshopTimerClientClockOffsetMs(timer, skewedClientNow);

    expect(offset).toBe(600_000);
    expect(workshopTimerRemainingMs(timer, skewedClientNow - offset)).toBe(
      60_000,
    );
    expect(
      workshopTimerRemainingMs(timer, skewedClientNow + 10_000 - offset),
    ).toBe(50_000);
  });

  it("keeps a paused server-provided remainder stable", () => {
    const timer: WorkshopTimer = {
      observedAt: 100_000,
      startedAt: 40_000,
      endsAt: null,
      pausedAt: 90_000,
      remainingMs: 23_000,
    };

    expect(workshopTimerRemainingMs(timer, 999_999)).toBe(23_000);
  });
});
