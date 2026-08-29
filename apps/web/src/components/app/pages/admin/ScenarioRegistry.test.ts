import { describe, expect, it } from "vitest";
import { formatScenarioResourceItems } from "./ScenarioRegistry";

describe("scenario registry resources", () => {
  it("formats aggregate CPU, vCPU, RAM, and disk requirements", () => {
    expect(
      formatScenarioResourceItems({
        cpuMillis: 2_000,
        vcpuCount: 2,
        memoryMib: 2_048,
        diskMib: 16_384,
      }),
    ).toEqual(["2 CPU", "2 vCPU", "2 GiB RAM", "16 GiB disk"]);
  });
});
