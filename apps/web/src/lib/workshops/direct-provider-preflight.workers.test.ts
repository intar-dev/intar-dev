import { describe, expect, it, vi } from "vitest";
import type { ProviderCapacityObservation } from "@intar/provider-contracts";
import {
  combineDirectProviderCapacity,
  rootDiskGibForPreflight,
} from "./direct-provider-preflight";
import { executeWorkshopProviderPreflight } from "./session-provider";
import type { RuntimeProviderAdapter } from "./runtime-provider";

function observation(input: {
  requestedSeats: number;
  availableSeats: number;
  capacityBasis?: ProviderCapacityObservation["capacityBasis"];
  reasons?: string[];
}): ProviderCapacityObservation {
  return {
    observedAt: "2026-08-02T00:00:00.000Z",
    requestedSeats: input.requestedSeats,
    availableSeats: input.availableSeats,
    preferredLocation: "europe-west3-a",
    availableLocations: ["europe-west3-a"],
    capacityBasis: input.capacityBasis ?? "quantitative_quota",
    reasons: input.reasons ?? [],
  };
}

describe("direct-cloud capacity composition", () => {
  it("rounds a non-whole-GiB Workshop disk requirement up safely", () => {
    expect(rootDiskGibForPreflight(32_768)).toBe(32);
    expect(rootDiskGibForPreflight(32_769)).toBe(33);
    expect(() => rootDiskGibForPreflight(0)).toThrow("invalid root disk");
  });

  it("passes the exact pinned profile and full requested roster through the generic adapter", async () => {
    const prepareSession = vi.fn(async (input) => ({
      profile: input.profile,
      connectionId: input.connection?.id ?? null,
      permittedLocations: input.profile.locations,
      catalogObservedAt: input.now,
    }));
    const preflight = vi.fn(async () => ({
      ok: true,
      availableSeats: 3,
      preferredLocation: "europe-west3-a",
      reasons: [],
    }));
    const adapter = {
      kind: "gcp_compute",
      prepareSession,
      preflight,
    } satisfies RuntimeProviderAdapter;
    await expect(
      executeWorkshopProviderPreflight({
        adapter,
        organizationId: "org",
        sessionId: "session",
        prepared: {
          runtimeProfileId: "runtime-profile",
          profileId: "gcp-e2-standard-4",
          providerKind: "gcp_compute",
          connectionId: "connection",
          resolvedProfile: {
            providerKind: "gcp_compute",
            vmId: "learner",
            machineType: "e2-standard-4",
            systemImage: "debian-13",
            resolvedImageId: "image-immutable",
            rootDiskType: "pd-balanced",
            locations: [
              "europe-west3-a",
              "europe-west3-b",
              "europe-west3-c",
            ],
            hardware: {
              architecture: "x86_64",
              cpuMillis: 4_000,
              memoryMib: 16_384,
              diskMib: 32_769,
              providerCpuCount: 4,
              providerMemoryMib: 16_384,
              providerDiskMib: 32_769,
            },
            configuration: {},
          },
        },
        requestedSeats: 3,
        quote: {
          currency: "USD",
          observedAt: 1,
          expiresAt: 2,
          lineItems: [],
        },
        now: 1,
      }),
    ).resolves.toMatchObject({ ok: true, availableSeats: 3 });
    expect(prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        profile: expect.objectContaining({
          id: "gcp-e2-standard-4",
          machineType: "e2-standard-4",
          hardware: expect.objectContaining({ diskMib: 32_769 }),
        }),
      }),
    );
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ requestedSeats: 3 }),
    );
  });

  it("counts existing session seats once while subtracting every active connection allocation", () => {
    expect(
      combineDirectProviderCapacity({
        requestedSeats: 4,
        sessionActiveSeats: 2,
        activeAllocations: 3,
        maxConcurrentAllocations: 5,
        observed: observation({ requestedSeats: 2, availableSeats: 2 }),
        fallbackLocation: "europe-west3-a",
      }),
    ).toMatchObject({ ok: true, availableSeats: 4, reasons: [] });

    expect(
      combineDirectProviderCapacity({
        requestedSeats: 4,
        sessionActiveSeats: 1,
        activeAllocations: 4,
        maxConcurrentAllocations: 5,
        observed: observation({ requestedSeats: 3, availableSeats: 3 }),
        fallbackLocation: "europe-west3-a",
      }),
    ).toMatchObject({
      ok: false,
      availableSeats: 2,
      reasons: [expect.stringContaining("1 seat(s) remaining")],
    });
  });

  it("retains Hetzner's availability-only warning while applying the connection ceiling", () => {
    expect(
      combineDirectProviderCapacity({
        requestedSeats: 3,
        sessionActiveSeats: 0,
        activeAllocations: 0,
        maxConcurrentAllocations: 5,
        observed: observation({
          requestedSeats: 3,
          availableSeats: 3,
          capacityBasis: "availability_only",
          reasons: ["Hetzner capacity is not guaranteed until allocation"],
        }),
        fallbackLocation: "nbg1",
      }),
    ).toMatchObject({
      ok: true,
      availableSeats: 3,
      reasons: ["Hetzner capacity is not guaranteed until allocation"],
    });

    expect(
      combineDirectProviderCapacity({
        requestedSeats: 3,
        sessionActiveSeats: 0,
        activeAllocations: 4,
        maxConcurrentAllocations: 5,
        observed: observation({
          requestedSeats: 3,
          availableSeats: 3,
          capacityBasis: "availability_only",
          reasons: ["Hetzner capacity is not guaranteed until allocation"],
        }),
        fallbackLocation: "nbg1",
      }),
    ).toMatchObject({
      ok: false,
      availableSeats: 1,
      reasons: [
        "Hetzner capacity is not guaranteed until allocation",
        expect.stringContaining("1 seat(s) remaining"),
      ],
    });
  });
});
