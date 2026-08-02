import { describe, expect, it, vi } from "vitest";
import {
  FlagshipFeatureToggleService,
  StaticFeatureToggleService,
  flagshipBindingFromEnvironment,
} from "./feature-toggles";

describe("feature toggle service", () => {
  it("fails closed when Flagship is not bound", async () => {
    const service = new FlagshipFeatureToggleService(null);
    await expect(
      service.getBoolean("organization-creation", false, {
        targetingKey: "user-1",
      }),
    ).resolves.toBe(false);
  });

  it("returns the caller default when Flagship throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new FlagshipFeatureToggleService({
      getBooleanValue: vi.fn().mockRejectedValue(new Error("unavailable")),
    });
    await expect(
      service.getBoolean("organization-creation", false),
    ).resolves.toBe(false);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("passes primitive targeting context to Flagship", async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true);
    const service = new FlagshipFeatureToggleService({ getBooleanValue });
    await expect(
      service.getBoolean("organization-creation", false, {
        targetingKey: "user-1",
      }),
    ).resolves.toBe(true);
    expect(getBooleanValue).toHaveBeenCalledWith(
      "organization-creation",
      false,
      { targetingKey: "user-1" },
    );
  });

  it("supports deterministic providers without depending on auth users", async () => {
    const service = new StaticFeatureToggleService({
      "organization-creation": true,
    });
    await expect(
      service.getBoolean("organization-creation", false, {
        targetingKey: "opaque-subject",
      }),
    ).resolves.toBe(true);
  });

  it("discovers only a compatible FLAGS binding", () => {
    const binding = { getBooleanValue: vi.fn() };
    expect(flagshipBindingFromEnvironment({ FLAGS: binding })).toBe(binding);
    expect(flagshipBindingFromEnvironment({ FLAGS: {} })).toBeNull();
    expect(flagshipBindingFromEnvironment(null)).toBeNull();
  });
});
