import {
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_PROTOCOL_VERSION,
  type ProviderCapabilities,
} from "@intar/provider-contracts";

export const GCP_PROVIDER_CAPABILITIES = Object.freeze({
  protocolVersion: PROVIDER_PROTOCOL_VERSION,
  providerKind: "gcp_compute",
  operations: PROVIDER_ADAPTER_OPERATIONS,
}) satisfies ProviderCapabilities<"gcp_compute">;
