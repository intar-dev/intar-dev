/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { summarizeDashboardProbes } from "./dashboard-host";

describe("dashboard verification summary", () => {
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
