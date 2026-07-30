/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import type {
  ProviderPriceObservation,
  WorkshopManifestV1,
} from "@/db/schema";
import {
  isProviderOnlyWorkshopRevision,
  prepareWorkshopSessionProvider,
  workshopForecastTriggerForResolvedPrices,
} from "./session-provider";

describe("workshop session provider selection", () => {
  it("rejects an explicit agent KVM fallback for provider-only revisions", async () => {
    const manifest = providerManifest([]);

    expect(isProviderOnlyWorkshopRevision(manifest)).toBe(true);
    await expect(
      prepareWorkshopSessionProvider({
        organizationId: "org-a",
        manifest,
        runtimeProvider: { kind: "agent_kvm" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_provider_required",
    });
  });

  it("rejects the implicit agent KVM default for provider-only revisions", async () => {
    await expect(
      prepareWorkshopSessionProvider({
        organizationId: "org-a",
        manifest: providerManifest([]),
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_provider_required",
    });
  });

  it("preserves agent KVM support for revisions that contain VM images", async () => {
    const prepared = await prepareWorkshopSessionProvider({
      organizationId: "org-a",
      manifest: providerManifest([
        {
          vmId: "learner",
          imageKey: { architecture: "x86_64" },
          imageSha256: "a".repeat(64),
        },
      ]),
      runtimeProvider: { kind: "agent_kvm" },
    });

    expect(prepared).toEqual({
      providerKind: "agent_kvm",
      connectionId: null,
      serverType: null,
      hardware: null,
      permittedLocations: [],
      initialPriceObservation: null,
    });
  });
});

describe("workshop session provider price refresh", () => {
  it("records a changed provider price as a price_changed forecast", () => {
    const previous = observation("0.6250");
    const resolved = observation("0.6500");

    expect(
      workshopForecastTriggerForResolvedPrices({
        requestedTrigger: "lobby_refresh",
        previous,
        resolved,
      }),
    ).toBe("price_changed");
  });
});

function observation(serverHourlyGross: string): ProviderPriceObservation {
  return {
    currency: "NOK",
    observedAt: 1_750_000_000_000,
    expiresAt: 1_750_086_400_000,
    serverType: "cx43",
    locations: [
      {
        location: "nbg1",
        available: true,
        serverHourlyNet: "0.5000",
        serverHourlyGross,
        serverMonthlyNet: "250.0000",
        serverMonthlyGross: "312.5000",
        ipv4HourlyNet: "0.0100",
        ipv4HourlyGross: "0.0125",
        ipv4MonthlyNet: "5.0000",
        ipv4MonthlyGross: "6.2500",
      },
    ],
  };
}

function providerManifest(
  vmImages: WorkshopManifestV1["workspace"]["checkpoints"][number]["vmImages"],
): WorkshopManifestV1 {
  return {
    workspace: {
      provider: {
        kind: "hetzner_cloud",
        vmId: "learner",
        serverType: "cx43",
        systemImage: "debian-13",
        hardware: {
          architecture: "x86",
          cores: 8,
          memoryMib: 16_384,
          diskMib: 163_840,
        },
        compatible: true,
      },
      checkpoints: [
        {
          id: "00",
          label: "Checkpoint 00",
          vmImages,
        },
      ],
    },
  } as WorkshopManifestV1;
}
