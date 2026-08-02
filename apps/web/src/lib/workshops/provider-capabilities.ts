import {
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_PROTOCOL_VERSION,
  type ProviderCapabilities,
} from "@intar/provider-contracts";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";

export type DirectCloudProviderKind = Exclude<
  RuntimeProviderKind,
  "agent_kvm"
>;

/**
 * Reject a service before any cloud mutation when its generated contract and
 * deployed entrypoint disagree. Equality is intentional: silently accepting
 * a partial or newer protocol would make the web lifecycle non-deterministic.
 */
export function assertProviderCapabilities(
  expectedKind: DirectCloudProviderKind,
  value: unknown,
): asserts value is ProviderCapabilities<DirectCloudProviderKind> {
  if (!isRecord(value)) {
    throw new TypeError("provider capabilities response is invalid");
  }
  if (value.protocolVersion !== PROVIDER_PROTOCOL_VERSION) {
    throw new TypeError("provider protocol version is incompatible");
  }
  if (value.providerKind !== expectedKind) {
    throw new TypeError("provider service kind does not match the binding");
  }
  if (!Array.isArray(value.operations)) {
    throw new TypeError("provider operations response is invalid");
  }
  const expected = new Set<string>(PROVIDER_ADAPTER_OPERATIONS);
  const observed = new Set<string>();
  for (const operation of value.operations) {
    if (typeof operation !== "string" || observed.has(operation)) {
      throw new TypeError("provider operations response is invalid");
    }
    observed.add(operation);
  }
  if (
    observed.size !== expected.size ||
    [...expected].some((operation) => !observed.has(operation))
  ) {
    throw new TypeError("provider service operations are incompatible");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
