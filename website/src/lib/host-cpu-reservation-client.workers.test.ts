/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { withSingleTimeoutRetry } from "@/lib/host-cpu-reservation-client";

describe("benchmark CPU reservation timeout recovery", () => {
  it("retries exactly once only after the local response timeout", async () => {
    let attempts = 0;
    const result = await withSingleTimeoutRetry(
      () => {
        attempts += 1;
        return attempts === 1
          ? new Promise<string>(() => undefined)
          : Promise.resolve("idempotent-acquisition");
      },
      1,
      "timed out",
    );

    expect(result).toBe("idempotent-acquisition");
    expect(attempts).toBe(2);
  });

  it("does not retry a non-timeout transport failure", async () => {
    let attempts = 0;
    await expect(
      withSingleTimeoutRetry(
        async () => {
          attempts += 1;
          throw new Error("transport failed");
        },
        10,
        "timed out",
      ),
    ).rejects.toThrow("transport failed");
    expect(attempts).toBe(1);
  });
});
