export const HCLOUD_PROVIDER_KIND = "hetzner_cloud" as const;
export const ENVELOPE_ALGORITHM = "AES-256-GCM" as const;
export const KEK_VERSION_V1 = "v1" as const;

export type HcloudProviderKind = typeof HCLOUD_PROVIDER_KIND;
export type KekVersion = typeof KEK_VERSION_V1;
export type HcloudResourceKind =
  | "firewall"
  | "primary_ip"
  | "ssh_key"
  | "server"
  | "action";

export interface CredentialContext {
  organizationId: string;
  connectionId: string;
  credentialId: string;
  provider: HcloudProviderKind;
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

interface BaseOwnershipLabels {
  organizationRef: string;
  connectionRef: string;
}

export interface ProviderConnectionSentinelOwnershipLabels
  extends BaseOwnershipLabels {
  purpose: "provider_connection_sentinel";
  workspaceRef?: never;
  generation?: never;
  workshopPublicationRef?: never;
  checkpointRef?: never;
  attempt?: never;
}

export interface LearnerWorkspaceOwnershipLabels
  extends BaseOwnershipLabels {
  purpose?: "learner_workspace";
  workspaceRef?: string;
  generation?: number;
  workshopPublicationRef?: never;
  checkpointRef?: never;
  attempt?: number;
}

export interface WorkshopPublicationVerifierOwnershipLabels
  extends BaseOwnershipLabels {
  purpose: "workshop_publication_verifier";
  workshopPublicationRef: string;
  checkpointRef: string;
  attempt: number;
  workspaceRef?: never;
  generation?: never;
}

export type OwnershipLabels =
  | ProviderConnectionSentinelOwnershipLabels
  | LearnerWorkspaceOwnershipLabels
  | WorkshopPublicationVerifierOwnershipLabels;

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
    | "action_observed";
  resourceKind: HcloudResourceKind;
  externalId: number;
  name?: string;
  actionIds: number[];
  state?: string;
  errorCode?: string;
  publicIpv4?: string;
}

export interface HcloudPrice {
  net: string;
  gross: string;
}

export interface HcloudLocation {
  id: number;
  name: string;
  description: string;
  country: string;
  city: string;
  latitude: number;
  longitude: number;
  network_zone: string;
}

export interface HcloudDeprecation {
  announced: string;
  unavailable_after: string;
}

export interface HcloudServerTypeLocation {
  id: number;
  name: string;
  recommended: boolean;
  available: boolean;
  deprecation?: HcloudDeprecation | null;
}

export interface HcloudServerType {
  id: number;
  name: string;
  description: string;
  category: string;
  cores: number;
  memory: number;
  disk: number;
  storage_type: string;
  cpu_type: string;
  architecture: string;
  deprecated?: boolean;
  deprecation?: HcloudDeprecation | null;
  locations?: HcloudServerTypeLocation[];
}

export interface HcloudImage {
  id: number;
  status: string;
  type: string;
  name: string | null;
  description: string;
  architecture: string;
  deprecated: string | null;
  deleted: string | null;
  os_flavor: string;
  os_version: string | null;
}

export interface HcloudAction {
  id: number;
  status: "running" | "success" | "error";
  command: string;
  progress: number;
  started: string;
  finished: string | null;
  error: { code: string; message: string } | null;
  resources: Array<{ id: number; type: string }>;
}

export interface HcloudFirewallRule {
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp" | "esp" | "gre";
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string;
}

export interface HcloudFirewall {
  id: number;
  name: string;
  labels: Record<string, string>;
  rules: HcloudFirewallRule[];
}

export interface HcloudPrimaryIp {
  id: number;
  created?: string;
  ip: string;
  labels: Record<string, string>;
  name: string;
  type: "ipv4" | "ipv6";
  assignee_id: number | null;
  assignee_type: string;
  auto_delete: boolean;
  blocked: boolean;
  location: HcloudLocation;
}

export interface HcloudSshKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  labels: Record<string, string>;
}

export interface HcloudServer {
  id: number;
  created?: string;
  name: string;
  status: string;
  labels: Record<string, string>;
  server_type: HcloudServerType;
  location: HcloudLocation;
  primary_disk_size: number;
  public_net: {
    ipv4: { id: number; ip: string; blocked: boolean };
    ipv6: { id: number; ip: string; blocked: boolean };
    floating_ips: number[];
    firewalls: Array<{ id: number; status: string }>;
  };
}

export interface HcloudPricing {
  currency: string;
  vat_rate: string;
  server_types: Array<{
    id: number;
    name: string;
    prices: Array<{
      location: string;
      price_hourly: HcloudPrice;
      price_monthly: HcloudPrice;
      included_traffic: number;
      price_per_tb_traffic: HcloudPrice;
    }>;
  }>;
  primary_ips: Array<{
    type: string;
    prices: Array<{
      location: string;
      price_hourly: HcloudPrice;
      price_monthly: HcloudPrice;
    }>;
  }>;
}

export interface NamedHcloudResource {
  id: number;
  name: string;
  labels?: Record<string, string>;
  type?: string;
}

export interface ProjectInventory {
  servers: HcloudServer[];
  primaryIps: HcloudPrimaryIp[];
  floatingIps: NamedHcloudResource[];
  firewalls: HcloudFirewall[];
  networks: NamedHcloudResource[];
  volumes: NamedHcloudResource[];
  placementGroups: NamedHcloudResource[];
  snapshots: HcloudImage[];
  sshKeys: HcloudSshKey[];
  loadBalancers: NamedHcloudResource[];
  certificates?: NamedHcloudResource[];
}

export interface CatalogObservation {
  observedAt: string;
  serverTypes: HcloudServerType[];
  locations: HcloudLocation[];
  systemImages: HcloudImage[];
  pricing: HcloudPricing;
}

export interface SentinelSpec {
  name: string;
  ownership: ProviderConnectionSentinelOwnershipLabels;
  stargateEgressIpv4Cidrs: string[];
}

export interface ConnectionRequestBase {
  requestId: string;
  connectionId: string;
  credentialContext: CredentialContext;
}

export interface ConnectProjectRequest extends ConnectionRequestBase {
  token: string;
  sentinel: SentinelSpec;
  requiredServerTypes: string[];
  permittedLocations: string[];
  systemImage: string;
}

export interface RotateCredentialRequest extends ConnectionRequestBase {
  token: string;
  sentinelId: number;
  sentinelName: string;
  ownership: ProviderConnectionSentinelOwnershipLabels;
}

export interface ConnectProjectResult {
  credential: EncryptedCredentialEnvelope;
  inventory: ProjectInventory;
  catalog: CatalogObservation;
  sentinel: HcloudFirewall;
  canonicalWrites: CanonicalProviderWrite[];
}

export interface RotateCredentialResult {
  credential: EncryptedCredentialEnvelope;
  sentinel: HcloudFirewall;
  canonicalWrites: CanonicalProviderWrite[];
}

export interface CreatePrimaryIpOperation {
  kind: "create_primary_ip";
  name: string;
  location: string;
  ownership: OwnershipLabels;
}

export interface CreateSshKeyOperation {
  kind: "create_ssh_key";
  name: string;
  publicKey: string;
  ownership: OwnershipLabels;
}

export interface CreateServerOperation {
  kind: "create_server";
  name: string;
  serverType: string;
  systemImage: string;
  location: string;
  primaryIpv4Id: number;
  sshKeyId: number;
  firewallId: number;
  cloudInit: string;
  ownership: OwnershipLabels;
}

export interface DeleteResourceOperation {
  kind: "delete_resource";
  resourceKind: "server" | "primary_ip" | "ssh_key" | "firewall";
  externalId: number;
  name?: string;
}

export interface GetActionOperation {
  kind: "get_action";
  actionId: number;
  maxWaitMs?: number;
}

export interface RebootServerOperation {
  kind: "reboot_server";
  serverId: number;
}

export interface ReconcileResourceRef {
  resourceKind: "server" | "primary_ip" | "ssh_key" | "firewall";
  externalId?: number;
  deterministicName: string;
  ownership: OwnershipLabels;
}

export interface ReconcileOperation {
  kind: "reconcile";
  resources: ReconcileResourceRef[];
  actionIds: number[];
}

export interface InventoryOperation {
  kind: "inventory";
}

export interface CatalogOperation {
  kind: "catalog";
  requiredServerTypes: string[];
  permittedLocations: string[];
  systemImage: string;
}

export interface PreflightCapacityOperation {
  kind: "preflight_capacity";
  serverType: string;
  permittedLocations: string[];
  systemImage: string;
  requestedSeats: number;
}

export interface EnsureSentinelOperation {
  kind: "ensure_sentinel";
  sentinel: SentinelSpec;
}

export type HcloudOperation =
  | CreatePrimaryIpOperation
  | CreateSshKeyOperation
  | CreateServerOperation
  | DeleteResourceOperation
  | GetActionOperation
  | RebootServerOperation
  | ReconcileOperation
  | InventoryOperation
  | CatalogOperation
  | PreflightCapacityOperation
  | EnsureSentinelOperation;

export interface RunOperationRequest extends ConnectionRequestBase {
  credential: EncryptedCredentialEnvelope;
  operation: HcloudOperation;
}

export interface ResourceObservation {
  ref: ReconcileResourceRef;
  status: "present" | "missing" | "ambiguous" | "ownership_mismatch";
  externalId?: number;
  resourceCreatedAt?: string;
  state?: string;
  publicIpv4?: string;
}

export interface ReconcileResult {
  observedAt: string;
  resources: ResourceObservation[];
  actions: HcloudAction[];
  canonicalWrites: CanonicalProviderWrite[];
}

export interface HcloudOperationResult {
  data: unknown;
  canonicalWrites: CanonicalProviderWrite[];
  mustPersistBeforeNextOperation: boolean;
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
