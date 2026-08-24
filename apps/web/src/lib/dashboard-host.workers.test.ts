/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import {
  isVerificationCollectionUnavailable,
  summarizeDashboardProbes,
} from "./dashboard-host";

describe("dashboard verification availability", () => {
  it("does not confuse a normal repair failure with a verifier outage", () => {
    expect(
      isVerificationCollectionUnavailable([
        { status: "fail", error: null },
      ]),
    ).toBe(false);
  });

  it("reports a non-passing probe error as unavailable", () => {
    expect(
      isVerificationCollectionUnavailable([
        { status: "error", error: null },
      ]),
    ).toBe(true);
    expect(
      isVerificationCollectionUnavailable([
        { status: "unknown", error: "collector unavailable" },
      ]),
    ).toBe(true);
  });

  it("lets a passing result override a stale error", () => {
    expect(
      isVerificationCollectionUnavailable([
        { status: "pass", error: "stale collector error" },
      ]),
    ).toBe(false);
  });

  it("counts legacy success aliases only as verified", () => {
    expect(
      summarizeDashboardProbes([
        { status: "passed" },
        { status: "ready" },
        { status: "fail" },
        { status: "unknown" },
      ]),
    ).toEqual({ total: 4, pass: 2, fail: 1, unknown: 1 });
  });
});
