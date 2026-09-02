import { describe, expect, it } from "vitest";
import { runtimeCapacityAllocationKey } from "@/lib/runtime-allocation-lock";

describe("scenario runtime allocation key", () => {
  it("scopes capacity by organization", () => {
    expect(runtimeCapacityAllocationKey(" org-1 ")).toBe(
      "runtime-capacity:organization:org-1",
    );
    expect(runtimeCapacityAllocationKey(null)).toBe("runtime-capacity:unscoped");
  });
});
