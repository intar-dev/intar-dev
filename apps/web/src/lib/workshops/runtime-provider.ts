/**
 * Provider-neutral contract used by the Workshop lifecycle.
 *
 * Public input and profile shapes live in the shared package. The web harness
 * owns durable state transitions. Provider services perform one bounded cloud
 * operation and cannot mutate Workshop progress, routes, or active slots.
 */
import {
  RUNTIME_PROVIDER_KINDS,
  type RuntimeHardwareShape,
  type RuntimeProviderKind,
  type RuntimeProviderSelection,
} from "@intar/workshop-contracts";

export {
  RUNTIME_PROVIDER_KINDS,
  type RuntimeHardwareShape,
  type RuntimeProviderKind,
  type RuntimeProviderSelection,
};

export interface ResolvedRuntimeProfile {
  id: string;
  providerKind: RuntimeProviderKind;
  vmId: string;
  machineType: string | null;
  systemImage: string;
  resolvedImageId: string | null;
  rootDiskType: string | null;
  locations: readonly string[];
  hardware: RuntimeHardwareShape;
  configuration: Readonly<Record<string, unknown>>;
}

export interface ProviderContext {
  organizationId: string;
  sessionId: string;
  now: number;
}

export interface ProviderConnectionRef {
  id: string;
  providerKind: Exclude<RuntimeProviderKind, "agent_kvm">;
}

export interface ProviderCostLineItem {
  providerKind: RuntimeProviderKind;
  sku: string;
  resourceKind: "instance" | "boot_disk" | "ipv4" | "ssh_key";
  location: string;
  currency: string;
  rawPrice: string;
  priceNanos: bigint;
  unit: string;
  quantityNanos: bigint;
  billingIncrementSeconds: number;
  minimumDurationSeconds: number;
  capPriceNanos: bigint | null;
  taxTreatment: "net" | "gross" | "tax_excluded";
}

export interface PrepareSessionRequest extends ProviderContext {
  profile: ResolvedRuntimeProfile;
  connection: ProviderConnectionRef | null;
}

export interface ProviderSessionPreparation {
  profile: ResolvedRuntimeProfile;
  connectionId: string | null;
  permittedLocations: readonly string[];
  catalogObservedAt: number;
}

export interface ProviderQuote {
  currency: string;
  observedAt: number;
  expiresAt: number;
  lineItems: readonly ProviderCostLineItem[];
}

export interface ProviderPreflightRequest extends ProviderContext {
  preparation: ProviderSessionPreparation;
  quote: ProviderQuote;
  requestedSeats: number;
}

export interface ProviderPreflightResult {
  ok: boolean;
  availableSeats: number;
  preferredLocation: string | null;
  reasons: readonly string[];
}

export type ProviderAllocationPhase =
  | "pending"
  | "creating"
  | "bootstrapping"
  | "ready"
  | "degraded"
  | "rebooting"
  | "draining"
  | "deleting"
  | "deleted"
  | "cleanup_pending"
  | "failed";

export interface RuntimeProviderAdapter {
  readonly kind: RuntimeProviderKind;
  prepareSession(
    input: PrepareSessionRequest,
  ): Promise<ProviderSessionPreparation>;
  preflight(input: ProviderPreflightRequest): Promise<ProviderPreflightResult>;
}

/** No provider inference or defaulting is allowed at this boundary. */
export function parseRuntimeProviderSelection(
  value: unknown,
): RuntimeProviderSelection {
  if (!isRecord(value)) {
    throw new TypeError("runtimeProvider is required");
  }
  const profileId = nonEmptyId(value.profileId, "runtimeProvider.profileId");
  const connectionId =
    value.connectionId === undefined
      ? undefined
      : nonEmptyId(value.connectionId, "runtimeProvider.connectionId");
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "profileId" && key !== "connectionId",
  );
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `runtimeProvider contains unsupported fields: ${unknownKeys.join(", ")}`,
    );
  }
  return connectionId === undefined ? { profileId } : { profileId, connectionId };
}

export function assertSelectionCompatible(input: {
  selection: RuntimeProviderSelection;
  profile: ResolvedRuntimeProfile;
  connection: ProviderConnectionRef | null;
}): void {
  if (input.selection.profileId !== input.profile.id) {
    throw new TypeError("runtimeProvider profile does not match the resolved profile");
  }
  if (input.profile.providerKind === "agent_kvm") {
    if (input.selection.connectionId !== undefined || input.connection !== null) {
      throw new TypeError("agent_kvm profiles cannot use a provider connection");
    }
    return;
  }
  if (!input.selection.connectionId || !input.connection) {
    throw new TypeError("direct-cloud profiles require a provider connection");
  }
  if (input.connection.id !== input.selection.connectionId) {
    throw new TypeError("runtimeProvider connection does not match the loaded connection");
  }
  if (input.connection.providerKind !== input.profile.providerKind) {
    throw new TypeError("runtimeProvider connection is incompatible with the profile");
  }
}

export function createRuntimeProviderRegistry(
  adapters: readonly RuntimeProviderAdapter[],
): ReadonlyMap<RuntimeProviderKind, RuntimeProviderAdapter> {
  const registry = new Map<RuntimeProviderKind, RuntimeProviderAdapter>();
  for (const adapter of adapters) {
    if (registry.has(adapter.kind)) {
      throw new TypeError(`duplicate runtime provider adapter: ${adapter.kind}`);
    }
    registry.set(adapter.kind, adapter);
  }
  return registry;
}

export function requireRuntimeProviderAdapter(
  registry: ReadonlyMap<RuntimeProviderKind, RuntimeProviderAdapter>,
  kind: RuntimeProviderKind,
): RuntimeProviderAdapter {
  const adapter = registry.get(kind);
  if (!adapter) {
    throw new TypeError(`runtime provider adapter is not registered: ${kind}`);
  }
  return adapter;
}

/**
 * Pin the ordered location attempts shared by learner and certification
 * allocations. Profile order is authoritative and connection policy may only
 * remove locations, never reorder or substitute them.
 */
export function orderedProviderLocationAttempts(input: {
  profileLocations: readonly string[];
  connectionLocations: readonly string[];
}): string[] {
  const connection = new Set(input.connectionLocations);
  const seen = new Set<string>();
  return input.profileLocations.filter((location) => {
    if (
      location.length === 0 ||
      seen.has(location) ||
      !connection.has(location)
    ) {
      return false;
    }
    seen.add(location);
    return true;
  });
}

export function nextProviderLocationAttempt(input: {
  locations: readonly string[];
  currentAttempt: number;
}): { location: string; attempt: number } | null {
  if (!Number.isSafeInteger(input.currentAttempt) || input.currentAttempt < 1) {
    throw new TypeError("provider location attempt must be a positive integer");
  }
  const location = input.locations[input.currentAttempt];
  return location === undefined
    ? null
    : { location, attempt: input.currentAttempt + 1 };
}

export function isDefinitiveLocationCapacityFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code =
    typeof error.code === "string"
      ? error.code
      : isRecord(error.shape) && typeof error.shape.code === "string"
        ? error.shape.code
        : null;
  return (
    code === "resource_unavailable" ||
    code === "hcloud_resource_unavailable" ||
    code === "gcp_resource_unavailable"
  );
}

function nonEmptyId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value)
  ) {
    throw new TypeError(`${field} must be a canonical non-empty identifier`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
