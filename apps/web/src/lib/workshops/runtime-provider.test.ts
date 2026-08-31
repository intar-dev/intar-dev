import { describe, expect, it, vi } from "vitest";
import {
  assertSelectionCompatible,
  createRuntimeProviderRegistry,
  isDefinitiveLocationCapacityFailure,
  nextProviderLocationAttempt,
  orderedProviderLocationAttempts,
  parseRuntimeProviderSelection,
  requireRuntimeProviderAdapter,
  type ResolvedRuntimeProfile,
  type RuntimeProviderAdapter,
  type RuntimeProviderKind,
} from "./runtime-provider";

function profile(
  id: string,
  providerKind: RuntimeProviderKind,
): ResolvedRuntimeProfile {
  return {
    id,
    providerKind,
    vmId: "learner",
    machineType: "test-machine",
    systemImage: "debian-13",
    resolvedImageId: "sha256:resolved",
    rootDiskType: null,
    locations: ["test-a"],
    hardware: {
      architecture: "x86_64",
      cpuMillis: 4_000,
      memoryMib: 16_384,
      diskMib: 32_768,
      providerCpuCount: 4,
      providerMemoryMib: 16_384,
      providerDiskMib: 32_768,
    },
    configuration: {},
  };
}

function adapter(kind: RuntimeProviderKind): RuntimeProviderAdapter {
  return {
    kind,
    prepareSession: vi.fn(async ({ profile, connection, now }) => ({
      profile,
      connectionId: connection?.id ?? null,
      permittedLocations: profile.locations,
      catalogObservedAt: now,
    })),
    preflight: vi.fn(async () => ({
      ok: true,
      availableSeats: 1,
      preferredLocation: "test-a",
      reasons: [],
    })),
  };
}

describe("runtime provider selection", () => {
  it("requires an explicit profile and does not default the provider", () => {
    expect(() => parseRuntimeProviderSelection(undefined)).toThrow(
      "runtimeProvider is required",
    );
    expect(parseRuntimeProviderSelection({ profileId: "hetzner-cpx42" })).toEqual(
      { profileId: "hetzner-cpx42" },
    );
    expect(
      parseRuntimeProviderSelection({
        profileId: "gcp-e2-standard-4",
        connectionId: "gcp-primary",
      }),
    ).toEqual({
      profileId: "gcp-e2-standard-4",
      connectionId: "gcp-primary",
    });
  });

  it("rejects malformed and shape-extending selections", () => {
    expect(() => parseRuntimeProviderSelection({ profileId: "" })).toThrow();
    expect(() =>
      parseRuntimeProviderSelection({ profileId: "valid", kind: "agent_kvm" }),
    ).toThrow("unsupported fields");
    expect(() =>
      parseRuntimeProviderSelection({ profileId: "valid", connectionId: "UPPER" }),
    ).toThrow("canonical non-empty identifier");
  });

  it("requires a matching direct-cloud connection and forbids one for agent KVM", () => {
    const gcp = profile("gcp-e2-standard-4", "gcp_compute");
    expect(() =>
      assertSelectionCompatible({
        selection: { profileId: gcp.id },
        profile: gcp,
        connection: null,
      }),
    ).toThrow("require a provider connection");
    expect(() =>
      assertSelectionCompatible({
        selection: { profileId: gcp.id, connectionId: "hetzner-primary" },
        profile: gcp,
        connection: {
          id: "hetzner-primary",
          providerKind: "hetzner_cloud",
        },
      }),
    ).toThrow("incompatible");
    expect(() =>
      assertSelectionCompatible({
        selection: { profileId: "agent-local", connectionId: "gcp-primary" },
        profile: profile("agent-local", "agent_kvm"),
        connection: { id: "gcp-primary", providerKind: "gcp_compute" },
      }),
    ).toThrow("cannot use a provider connection");
  });
});

describe("runtime provider registry", () => {
  it("does not fall back when a selected provider is not registered", () => {
    const registry = createRuntimeProviderRegistry([adapter("agent_kvm")]);
    expect(() => requireRuntimeProviderAdapter(registry, "gcp_compute")).toThrow(
      "not registered",
    );
  });

  it("rejects duplicate implementations", () => {
    expect(() =>
      createRuntimeProviderRegistry([
        adapter("hetzner_cloud"),
        adapter("hetzner_cloud"),
      ]),
    ).toThrow("duplicate runtime provider adapter");
  });
});

describe("provider location attempts", () => {
  it("pins the full profile-ordered intersection with connection approval", () => {
    expect(
      orderedProviderLocationAttempts({
        profileLocations: ["zone-b", "zone-a", "zone-c", "zone-a"],
        connectionLocations: ["zone-a", "zone-b", "zone-c"],
      }),
    ).toEqual(["zone-b", "zone-a", "zone-c"]);
  });

  it("advances one pinned attempt at a time without substituting a machine type", () => {
    expect(
      nextProviderLocationAttempt({
        locations: ["zone-a", "zone-b"],
        currentAttempt: 1,
      }),
    ).toEqual({ location: "zone-b", attempt: 2 });
    expect(
      nextProviderLocationAttempt({
        locations: ["zone-a", "zone-b"],
        currentAttempt: 2,
      }),
    ).toBeNull();
  });

  it("falls back only for explicit location-capacity errors", () => {
    expect(
      isDefinitiveLocationCapacityFailure({ code: "resource_unavailable" }),
    ).toBe(true);
    expect(
      isDefinitiveLocationCapacityFailure({
        shape: { code: "gcp_resource_unavailable" },
      }),
    ).toBe(true);
    for (const code of [
      "runtime_provider_service_unavailable",
      "hcloud_transport_error",
      "gcp_quota_exceeded",
      "gcp_permission_denied",
    ]) {
      expect(isDefinitiveLocationCapacityFailure({ code })).toBe(false);
    }
  });
});
