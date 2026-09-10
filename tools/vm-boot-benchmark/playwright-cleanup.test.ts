import { describe, expect, test } from "bun:test";
import { terminalStatus } from "./playwright-cleanup";

describe("Playwright VM boot benchmark cleanup", () => {
  test("waits until every VM has completed teardown", () => {
    expect(
      terminalStatus({
        phase: "failed",
        vms: [{ phase: "failed" }, { phase: "destroying" }],
      }),
    ).toBeNull();
    expect(
      terminalStatus({
        phase: "completed",
        vms: [{ phase: "completed" }, { phase: "failed" }],
      }),
    ).toBeNull();
    expect(
      terminalStatus({
        phase: "failed",
        vms: [{ phase: "completed" }, { phase: "completed" }],
      }),
    ).toBe("failed");
  });
});
