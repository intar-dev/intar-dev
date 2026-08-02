import {
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_PROTOCOL_VERSION,
  type ProviderCapabilities,
} from "@intar/provider-contracts";

export const HETZNER_PROVIDER_CAPABILITIES = Object.freeze({
  protocolVersion: PROVIDER_PROTOCOL_VERSION,
  providerKind: "hetzner_cloud",
  operations: PROVIDER_ADAPTER_OPERATIONS,
}) satisfies ProviderCapabilities<"hetzner_cloud">;
