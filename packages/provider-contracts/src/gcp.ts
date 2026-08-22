import type {
  CanonicalProviderWrite,
  EncryptedCredentialEnvelope,
  ProviderCapacityObservation,
  ProviderCredentialContext,
  ProviderOperationResult,
  ProviderOwnership,
  ProviderRequestBase,
} from "./index";
import type { ProviderPriceLineItem } from "@intar/workshop-contracts";

export const GCP_PROVIDER_KIND = "gcp_compute" as const;
export type GcpCredentialContext = ProviderCredentialContext<typeof GCP_PROVIDER_KIND>;

export interface GcpServiceAccountKey {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: "https://accounts.google.com/o/oauth2/auth" | string;
  token_uri: "https://oauth2.googleapis.com/token" | string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  universe_domain?: string;
}

export interface GcpConnectionRequestBase
  extends ProviderRequestBase<typeof GCP_PROVIDER_KIND> {
  credentialContext: GcpCredentialContext;
}

export interface GcpFoundationSpec {
  networkName: string;
  subnetworkName: string;
  subnetworkRegion: "europe-west3";
  subnetworkCidr: string;
  firewallName: string;
  stargateEgressIpv4Cidrs: string[];
  ownership: ProviderOwnership;
}

export interface ConnectGcpProjectRequest extends GcpConnectionRequestBase {
  serviceAccountKeyJson: string;
  projectId: string;
  permittedZones: string[];
  requiredMachineTypes: string[];
  imageFamily: string;
  foundation: GcpFoundationSpec;
}

export interface RotateGcpCredentialRequest extends GcpConnectionRequestBase {
  serviceAccountKeyJson: string;
  projectId: string;
  sentinelNetworkSelfLink: string;
  ownership: ProviderOwnership;
}

export interface GcpProjectIdentity {
  projectId: string;
  projectNumber: string;
  displayName: string;
  lifecycleState: string;
  serviceAccountEmail: string;
}

export interface GcpQuotaObservation {
  metric: string;
  limit: number;
  usage: number;
  available: number;
}

export interface GcpProjectBillingInfo {
  projectId: string;
  billingAccountName: string;
  billingEnabled: true;
}

export interface GcpProjectValidation {
  enabledServices: string[];
  grantedPermissions: string[];
  quotas: GcpQuotaObservation[];
  billing: GcpProjectBillingInfo;
}

export type GcpProviderReadinessResult =
  | {
      mode: "dormant";
      readyForNewWork: false;
      catalog: { checked: false };
    }
  | {
      mode: "active";
      readyForNewWork: true;
      catalog: {
        checked: true;
        observedAt: string;
        lineItemCount: number;
      };
    };

export interface GcpResourceRef {
  id: string;
  name: string;
  selfLink: string;
  labels?: Record<string, string>;
  zone?: string;
  region?: string;
  status?: string;
  creationTimestamp?: string;
  description?: string;
  network?: string;
  routeType?: string;
  nextHopGateway?: string;
  destRange?: string;
  priority?: number;
  tags?: string[];
}

export interface GcpProjectInventory {
  instances: GcpResourceRef[];
  disks: GcpResourceRef[];
  addresses: GcpResourceRef[];
  snapshots: GcpResourceRef[];
  images: GcpResourceRef[];
  instanceTemplates: GcpResourceRef[];
  instanceGroups: GcpResourceRef[];
  forwardingRules: GcpResourceRef[];
  targetPools: GcpResourceRef[];
  backendServices: GcpResourceRef[];
  networks: GcpResourceRef[];
  subnetworks: GcpResourceRef[];
  firewalls: GcpResourceRef[];
  routes: GcpResourceRef[];
  computeAssets: GcpComputeAsset[];
  defaultNetworkPresent: boolean;
}

export type GcpInventoryResourceKind =
  | "instance"
  | "disk"
  | "address"
  | "snapshot"
  | "image"
  | "instance_template"
  | "instance_group"
  | "forwarding_rule"
  | "target_pool"
  | "backend_service"
  | "network"
  | "subnetwork"
  | "firewall"
  | "route";

export interface GcpClassifiedInventoryResource {
  resourceKind: GcpInventoryResourceKind;
  resource: GcpResourceRef;
}

export interface GcpOperationalInventoryClassification {
  status: "empty" | "owned_resources_present" | "foreign_resources_present";
  ownedResources: GcpClassifiedInventoryResource[];
  foreignResources: GcpClassifiedInventoryResource[];
  ownedComputeAssets: GcpComputeAsset[];
  foreignComputeAssets: GcpComputeAsset[];
  defaultNetworkPresent: boolean;
}

export type GcpOperationalConnectionValidation =
  | {
      authority: "cleanup_only";
      grantedCleanupPermissions: string[];
    }
  | {
      authority: "active";
      enabledServices: string[];
      grantedPermissions: string[];
      quotas: GcpQuotaObservation[];
      billing: GcpProjectBillingInfo;
      machineTypes: GcpMachineType[];
      resolvedImage: GcpResolvedImage;
      foundation: GcpFoundationObservation;
    };

export interface GcpOperationalConnectionInspection {
  identity: GcpProjectIdentity;
  inventory: GcpProjectInventory;
  validation: GcpOperationalConnectionValidation;
  classification: GcpOperationalInventoryClassification;
}

export interface GcpComputeAsset {
  fullResourceName: string;
  assetType: string;
  displayName: string;
  location: string;
  state?: string;
  labels?: Record<string, string>;
}

export interface GcpMachineType {
  id: string;
  name: string;
  selfLink: string;
  zone: string;
  guestCpus: number;
  memoryMib: number;
  architecture: "X86_64" | "ARM64" | string;
  deprecated?: { state: string; replacement?: string; deleted?: string };
}

export interface GcpResolvedImage {
  id: string;
  name: string;
  selfLink: string;
  family?: string;
  architecture: "X86_64" | "ARM64" | string;
  status: string;
  diskSizeGb: string;
  creationTimestamp: string;
  deprecated?: { state: string; replacement?: string; deleted?: string };
}

export interface GcpCatalogObservation {
  observedAt: string;
  machineTypes: GcpMachineType[];
  resolvedImage: GcpResolvedImage;
  prices: ProviderPriceLineItem[];
}

export interface GcpFoundationObservation {
  network: GcpResourceRef;
  subnetwork: GcpResourceRef;
  firewall: GcpResourceRef;
  createdResourceSelfLinks: string[];
}

export interface ConnectGcpProjectResult {
  credential: EncryptedCredentialEnvelope;
  identity: GcpProjectIdentity;
  inventory: GcpProjectInventory;
  validation: GcpProjectValidation;
  catalog: GcpCatalogObservation;
  foundation: GcpFoundationObservation;
  canonicalWrites: CanonicalProviderWrite[];
}

export interface RotateGcpCredentialResult {
  credential: EncryptedCredentialEnvelope;
  identity: GcpProjectIdentity;
  sentinelNetwork: GcpResourceRef;
  authority: "active" | "cleanup_only";
}

export interface ResolveGcpProfileOperation {
  kind: "resolve_profile";
  machineType: string;
  zones: string[];
  imageFamily: string;
  resolvedImageId?: string;
}

export interface QuoteGcpProfileOperation {
  kind: "quote";
  machineType: string;
  zones: string[];
  rootDiskType: "pd-balanced";
  rootDiskGib: number;
}

export interface PreflightGcpProfileOperation {
  kind: "preflight_capacity";
  machineType: string;
  zones: string[];
  rootDiskType: "pd-balanced";
  rootDiskGib: number;
  requestedSeats: number;
}

export interface GcpCapacityObservation extends ProviderCapacityObservation {
  capacityBasis: "quantitative_quota" | "unavailable";
  quotas: GcpQuotaObservation[];
  cpuPerSeat: number;
  instancesPerSeat: 1;
  addressesPerSeat: 1;
  diskGibPerSeat: number;
}

export interface InspectGcpConnectionOperation {
  kind: "inspect_connection";
  foundation: GcpFoundationSpec;
  zones: string[];
}

export interface EnsureGcpFoundationOperation {
  kind: "ensure_foundation";
  foundation: GcpFoundationSpec;
}

export interface ValidateGcpFoundationOperation {
  kind: "validate_foundation";
  foundation: GcpFoundationSpec;
}

export interface CreateGcpInstanceOperation {
  kind: "create_instance";
  name: string;
  zone: string;
  machineType: string;
  sourceImage: string;
  rootDiskType: "pd-balanced";
  rootDiskGib: number;
  networkSelfLink: string;
  subnetworkSelfLink: string;
  cloudInit: string;
  ownership: ProviderOwnership;
  generation: number;
}

export interface ObserveGcpOperationOperation {
  kind: "observe_operation";
  operationSelfLink: string;
}

export interface ObserveGcpAllocationOperation {
  kind: "observe_allocation";
  zone: string;
  instanceName: string;
  bootDiskName?: string;
  ownership: ProviderOwnership;
}

export interface RebootGcpInstanceOperation {
  kind: "reboot_instance";
  zone: string;
  instanceName: string;
  ownership: ProviderOwnership;
}

export interface DeleteGcpInstanceOperation {
  kind: "delete_instance";
  zone: string;
  instanceName: string;
  ownership: ProviderOwnership;
}

export interface DeleteGcpDiskOperation {
  kind: "delete_disk";
  zone: string;
  diskName: string;
  ownership: ProviderOwnership;
}

export interface SweepGcpResourcesOperation {
  kind: "sweep";
  ownership: ProviderOwnership;
}

export type GcpProviderOperation =
  | ResolveGcpProfileOperation
  | QuoteGcpProfileOperation
  | PreflightGcpProfileOperation
  | InspectGcpConnectionOperation
  | EnsureGcpFoundationOperation
  | ValidateGcpFoundationOperation
  | CreateGcpInstanceOperation
  | ObserveGcpOperationOperation
  | ObserveGcpAllocationOperation
  | RebootGcpInstanceOperation
  | DeleteGcpInstanceOperation
  | DeleteGcpDiskOperation
  | SweepGcpResourcesOperation;

export interface RunGcpOperationRequest extends GcpConnectionRequestBase {
  credential: EncryptedCredentialEnvelope;
  projectId: string;
  operation: GcpProviderOperation;
}

export interface GcpAsyncOperation {
  id: string;
  name: string;
  selfLink: string;
  status: "PENDING" | "RUNNING" | "DONE" | string;
  operationType?: string;
  targetLink?: string;
  targetId?: string;
  zone?: string;
  region?: string;
  httpErrorStatusCode?: number;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

export interface GcpAllocationObservation {
  instance: GcpResourceRef | null;
  bootDisk: GcpResourceRef | null;
  publicIpv4?: string;
  status: "present" | "missing" | "ownership_mismatch";
}

export type GcpInstanceAdvanceResult =
  | {
      outcome: "created";
      requestId: string;
      operation: GcpAsyncOperation;
    }
  | {
      outcome: "reconciled";
      requestId: string;
      observation: GcpAllocationObservation;
    };

export type GcpOperationResult<T = unknown> = ProviderOperationResult<T>;
