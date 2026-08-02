import { describe, expect, it } from "vitest";
import { deterministicRuntimeVmName } from "./runtime-vm-name";

describe("deterministicRuntimeVmName", () => {
  it("keeps the lab 3 runtime hostname DNS-safe", () => {
    const name = deterministicRuntimeVmName(
      "kubernetes-devops-fundamentals-03-repair-configuration-control-plane",
      "jny8pcue3ziuiz28u5v08qck",
      0,
    );

    expect(name).toBe(
      "kubernetes-devops-fundamentals-03-repair-configuration-jny8pc-1",
    );
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(name).toHaveLength(63);
  });

  it("preserves the run and VM discriminator for long prefixes", () => {
    const firstRun = deterministicRuntimeVmName("a".repeat(80), "runone123", 0);
    const secondRun = deterministicRuntimeVmName(
      "a".repeat(80),
      "runtwo456",
      1,
    );

    expect(firstRun.endsWith("-runone-1")).toBe(true);
    expect(secondRun.endsWith("-runtwo-2")).toBe(true);
    expect(firstRun).not.toBe(secondRun);
    expect(firstRun.length).toBeLessThanOrEqual(63);
    expect(secondRun.length).toBeLessThanOrEqual(63);
  });

  it("removes trailing dashes from the retained prefix", () => {
    const name = deterministicRuntimeVmName(`${"a".repeat(54)}----`, "abcdef123", 0);

    expect(name).toBe(`${"a".repeat(54)}-abcdef-1`);
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });
});
