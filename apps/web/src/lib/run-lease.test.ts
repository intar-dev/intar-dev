import { describe, expect, it } from "vitest";
import {
  computeLeaseDeadline,
  formatCountdown,
  leaseInfo,
} from "./run-lease";

describe("computeLeaseDeadline", () => {
  it("takes the earliest lease across VMs", () => {
    const created = 1_000_000;
    expect(computeLeaseDeadline(created, [3600, 1800, null])).toBe(
      created + 1800 * 1000,
    );
  });
  it("returns null when no VM has a lease", () => {
    expect(computeLeaseDeadline(1000, [null, undefined, 0])).toBeNull();
  });
});

describe("leaseInfo", () => {
  const deadline = 100_000_000;
  it("ok when far out", () => {
    expect(leaseInfo(deadline, deadline - 30 * 60 * 1000).state).toBe("ok");
  });
  it("warning under 10m", () => {
    expect(leaseInfo(deadline, deadline - 5 * 60 * 1000).state).toBe("warning");
  });
  it("critical under 2m", () => {
    expect(leaseInfo(deadline, deadline - 60 * 1000).state).toBe("critical");
  });
  it("expired at/after deadline", () => {
    expect(leaseInfo(deadline, deadline).state).toBe("expired");
    expect(leaseInfo(deadline, deadline + 1).state).toBe("expired");
    expect(leaseInfo(deadline, deadline + 1).remainingMs).toBe(0);
  });
  it("null deadline is inert", () => {
    expect(leaseInfo(null, 123).deadlineMs).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("formats mm:ss", () => {
    expect(formatCountdown(65_000)).toBe("01:05");
  });
  it("formats h:mm:ss over an hour", () => {
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
  });
  it("clamps negatives to 00:00", () => {
    expect(formatCountdown(-5000)).toBe("00:00");
  });
});
