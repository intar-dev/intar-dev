import type { RuntimeProviderKind } from "@intar/workshop-contracts";

export const PROVIDER_PROTOCOL_VERSION = 1 as const;

export const PROVIDER_ADAPTER_OPERATIONS = [
  "resolveProfile",
  "prepareSession",
  "quote",
  "preflight",
  "advanceAllocation",
  "observeAllocation",
  "reboot",
  "advanceDeletion",
  "inspectConnection",
  "rotateCredential",
  "sweep",
] as const;

export type ProviderAdapterOperation =
  (typeof PROVIDER_ADAPTER_OPERATIONS)[number];

export interface ProviderCapabilities<
  Kind extends Exclude<RuntimeProviderKind, "agent_kvm"> = Exclude<
    RuntimeProviderKind,
    "agent_kvm"
  >,
> {
  protocolVersion: typeof PROVIDER_PROTOCOL_VERSION;
  providerKind: Kind;
  operations: readonly ProviderAdapterOperation[];
}

export interface ServiceErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  providerStatus?: number;
  providerRequestId?: string;
  retryAfterSeconds?: number;
}

export type ProviderRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ServiceErrorShape };

export const ENVELOPE_ALGORITHM = "AES-256-GCM" as const;
export const KEK_VERSION_V1 = "v1" as const;
export type KekVersion = typeof KEK_VERSION_V1;

export interface ProviderCredentialContext<
  Kind extends Exclude<RuntimeProviderKind, "agent_kvm"> = Exclude<
    RuntimeProviderKind,
    "agent_kvm"
  >,
> {
  organizationId: string;
  connectionId: string;
  credentialId: string;
  provider: Kind;
  version: number;
}

export interface EncryptedCredentialEnvelope {
  algorithm: typeof ENVELOPE_ALGORITHM;
  kekVersion: KekVersion;
  aadSha256: string;
  wrappedDek: string;
  wrappedDekIv: string;
  ciphertext: string;
  ciphertextIv: string;
  createdAt: string;
}

export interface ProviderRequestBase<
  Kind extends Exclude<RuntimeProviderKind, "agent_kvm">,
> {
  requestId: string;
  connectionId: string;
  credentialContext: ProviderCredentialContext<Kind>;
}

export interface ProviderOwnership {
  organizationRef: string;
  connectionRef: string;
  purpose:
    | "provider_connection_sentinel"
    | "learner_workspace"
    | "workshop_publication_verifier";
  workspaceRef?: string;
  generation?: number;
  workshopPublicationRef?: string;
  checkpointRef?: string;
  attempt?: number;
}

export interface CanonicalProviderWrite {
  requestId: string;
  connectionId: string;
  observedAt: string;
  resourceCreatedAt?: string;
  operation:
    | "resource_created"
    | "resource_observed"
    | "resource_deletion_requested"
    | "resource_deleted"
    | "operation_observed";
  resourceKind: string;
  externalId: string;
  name?: string;
  operationIds: string[];
  state?: string;
  errorCode?: string;
  publicIpv4?: string;
  location?: string;
}

export interface ProviderOperationResult<T = unknown> {
  data: T;
  canonicalWrites: CanonicalProviderWrite[];
  mustPersistBeforeNextOperation: boolean;
}

/**
 * A point-in-time, read-only capacity observation returned by a private
 * provider Worker. `availableSeats` is deliberately bounded to the requested
 * seats; callers must still apply organization guardrails and account for
 * allocations already present in canonical D1 state.
 */
export interface ProviderCapacityObservation {
  observedAt: string;
  requestedSeats: number;
  availableSeats: number;
  preferredLocation: string | null;
  availableLocations: string[];
  capacityBasis: "quantitative_quota" | "availability_only" | "unavailable";
  reasons: string[];
}

export interface ProviderServiceContract<Kind extends "hetzner_cloud" | "gcp_compute"> {
  capabilities(): Promise<ProviderCapabilities<Kind>> | ProviderCapabilities<Kind>;
}
