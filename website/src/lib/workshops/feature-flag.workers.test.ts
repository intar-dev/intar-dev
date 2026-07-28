/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";
import { FlagshipFeatureToggleService } from "@/lib/feature-toggles";
import {
  isWorkshopHcloudRuntimeEnabledForOrganization,
  requireWorkshopHcloudRuntimeEnabledForOrganization,
  WORKSHOP_HCLOUD_RUNTIME_FEATURE_FLAG,
  WORKSHOPS_FEATURE_FLAG,
  isWorkshopsEnabledForOrganization,
  requireWorkshopsEnabledForOrganization,
} from "./feature-flag";

describe("workshop organization feature flag", () => {
  it("fails closed without a Flagship binding", async () => {
    await expect(
      isWorkshopsEnabledForOrganization(
        "org-pilot",
        new FlagshipFeatureToggleService(null),
      ),
    ).resolves.toBe(false);
    await expect(
      requireWorkshopsEnabledForOrganization(
        "org-pilot",
        new FlagshipFeatureToggleService(null),
      ),
    ).rejects.toMatchObject({ status: 404, code: "workshops_not_found" });
  });

  it("targets the organization and uses a false default", async () => {
    const getBoolean = vi.fn().mockResolvedValue(true);
    await expect(
      isWorkshopsEnabledForOrganization("org-pilot", { getBoolean }),
    ).resolves.toBe(true);
    expect(getBoolean).toHaveBeenCalledWith(WORKSHOPS_FEATURE_FLAG, false, {
      targetingKey: "org-pilot",
      organizationId: "org-pilot",
    });
  });
});

describe("Hetzner workshop runtime feature flag", () => {
  it("uses organization targeting and defaults off", async () => {
    const service = {
      getBoolean: vi.fn().mockResolvedValue(false),
    };
    await expect(
      isWorkshopHcloudRuntimeEnabledForOrganization("org-a", service),
    ).resolves.toBe(false);
    expect(service.getBoolean).toHaveBeenCalledWith(
      WORKSHOP_HCLOUD_RUNTIME_FEATURE_FLAG,
      false,
      { targetingKey: "org-a", organizationId: "org-a" },
    );
    await expect(
      requireWorkshopHcloudRuntimeEnabledForOrganization("org-a", service),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_hcloud_runtime_not_found",
    });
  });
});
