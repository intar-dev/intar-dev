import { describe, expect, it } from "vitest";
import { HOST_DEGRADED_AFTER_MS, hostHealth } from "@/lib/host-health";

describe("hostHealth", () => {
  it("treats missing reports as unknown", () => {
    expect(hostHealth(null, 1_762_041_660_000)).toBe("unknown");
  });

  it("stays healthy at the exact degraded boundary", () => {
    const now = 1_762_041_660_000;
    expect(hostHealth(now - HOST_DEGRADED_AFTER_MS, now)).toBe("healthy");
  });

  it("marks reports older than the degraded threshold as degraded", () => {
    const now = 1_762_041_660_000;
    expect(hostHealth(now - HOST_DEGRADED_AFTER_MS - 1, now)).toBe(
      "degraded",
    );
  });
});
