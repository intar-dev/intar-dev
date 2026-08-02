import type {
  CreateGcpInstanceOperation,
  GcpAllocationObservation,
  GcpAsyncOperation,
  GcpClassifiedInventoryResource,
  GcpComputeAsset,
  GcpFoundationObservation,
  GcpFoundationSpec,
  GcpInstanceAdvanceResult,
  GcpMachineType,
  GcpProjectIdentity,
  GcpProjectInventory,
  GcpOperationalInventoryClassification,
  GcpQuotaObservation,
  GcpResolvedImage,
  GcpResourceRef,
  GcpServiceAccountKey,
} from "@intar/provider-contracts/gcp";
import type { ProviderOwnership } from "@intar/provider-contracts";
import {
  ProviderServiceError,
  deterministicRequestId,
} from "@intar/provider-worker-core";
import { GcpApi, GcpApiError, type GcpApiOptions } from "./gcp-api";

const REQUIRED_SERVICES = [
  "compute.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "serviceusage.googleapis.com",
  "cloudasset.googleapis.com",
] as const;
export const CLEANUP_IAM_PERMISSIONS = [
  "cloudasset.assets.searchAllResources",
  "compute.addresses.list",
  "compute.backendServices.list",
  "compute.disks.delete",
  "compute.disks.get",
  "compute.disks.list",
  "compute.firewalls.get",
  "compute.firewalls.list",
  "compute.forwardingRules.list",
  "compute.globalOperations.get",
  "compute.images.list",
  "compute.instanceGroups.list",
  "compute.instanceTemplates.list",
  "compute.instances.delete",
  "compute.instances.get",
  "compute.instances.list",
  "compute.networks.get",
  "compute.networks.list",
  "compute.projects.get",
  "compute.regionOperations.get",
  "compute.routes.list",
  "compute.snapshots.list",
  "compute.subnetworks.get",
  "compute.subnetworks.list",
  "compute.targetPools.list",
  "compute.zoneOperations.get",
  "resourcemanager.projects.get",
] as const;
export const REQUIRED_IAM_PERMISSIONS = [
  ...CLEANUP_IAM_PERMISSIONS,
  "compute.disks.create",
  "compute.disks.use",
  "compute.firewalls.create",
  "compute.instances.create",
  "compute.instances.reset",
  "compute.machineTypes.get",
  "compute.networks.create",
  "compute.networks.use",
  "compute.regions.get",
  "compute.subnetworks.create",
  "compute.subnetworks.use",
  "compute.subnetworks.useExternalIp",
  "serviceusage.services.list",
] as const;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const WORKSHOP_REGION = "europe-west3" as const;
const ZONE_PATTERN = /^europe-west3-[abc]$/u;
const RESOURCE_NAME_PATTERN = /^intar-[a-z](?:[a-z0-9-]{0,59}[a-z0-9])?$/u;

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

interface AggregatedListResponse<T> {
  items?: Record<string, Record<string, T[] | undefined>>;
  nextPageToken?: string;
}

interface ApiResource {
  id?: string;
  name?: string;
  selfLink?: string;
  labels?: Record<string, string>;
  zone?: string;
  region?: string;
  status?: string;
  description?: string;
  network?: string;
  routeType?: string;
  nextHopGateway?: string;
  destRange?: string;
  priority?: number;
  tags?: string[];
}

interface ApiInstance extends ApiResource {
  disks?: Array<{ boot?: boolean; source?: string }>;
  networkInterfaces?: Array<{
    networkIP?: string;
    accessConfigs?: Array<{ natIP?: string; type?: string }>;
  }>;
}

interface ProjectResponse {
  projectId?: string;
  projectNumber?: string;
  name?: string;
  displayName?: string;
  lifecycleState?: string;
}

interface ServiceListResponse {
  services?: Array<{ name?: string; state?: string }>;
  nextPageToken?: string;
}

interface IamPermissionsResponse {
  permissions?: string[];
}

interface ComputeRegionResponse {
  quotas?: Array<{ metric?: string; limit?: number; usage?: number }>;
}

export interface GcpQuotaCapacity {
  quotas: GcpQuotaObservation[];
  availableSeats: number;
  reasons: string[];
}

interface CloudAssetSearchResponse {
  results?: Array<{
    name?: string;
    assetType?: string;
    displayName?: string;
    location?: string;
    state?: string;
    labels?: Record<string, string>;
  }>;
  nextPageToken?: string;
}

function resourceRef(value: ApiResource, scope?: string): GcpResourceRef {
  if (!value.id || !value.name || !value.selfLink) {
    throw new ProviderServiceError({
      code: "gcp_invalid_response",
      message: "GCP API returned an incomplete resource",
      retryable: false,
    });
  }
  const zone = value.zone ?? (scope?.startsWith("zones/") ? scope : undefined);
  const region = value.region ?? (scope?.startsWith("regions/") ? scope : undefined);
  return {
    id: value.id,
    name: value.name,
    selfLink: value.selfLink,
    ...(value.labels ? { labels: value.labels } : {}),
    ...(zone ? { zone } : {}),
    ...(region ? { region } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.network ? { network: value.network } : {}),
    ...(value.routeType ? { routeType: value.routeType } : {}),
    ...(value.nextHopGateway ? { nextHopGateway: value.nextHopGateway } : {}),
    ...(value.destRange ? { destRange: value.destRange } : {}),
    ...(value.priority !== undefined ? { priority: value.priority } : {}),
    ...(value.tags ? { tags: value.tags } : {}),
  };
}

function assertProject(projectId: string): void {
  if (!PROJECT_PATTERN.test(projectId)) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "GCP project id is invalid",
      retryable: false,
    });
  }
}

function assertAllocationIdentity(zone: string, instanceName: string): void {
  if (!ZONE_PATTERN.test(zone) || !RESOURCE_NAME_PATTERN.test(instanceName)) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "GCP allocation identity is invalid",
      retryable: false,
    });
  }
}

function validIpv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255 && String(parsed) === octet;
  });
}

function validIpv4Cidr(value: string, prefix: 24 | 32): boolean {
  const suffix = `/${prefix}`;
  if (!value.endsWith(suffix)) return false;
  const address = value.slice(0, -suffix.length);
  if (!validIpv4(address)) return false;
  return prefix !== 24 || address.endsWith(".0");
}

function validComputeSelfLink(value: string, expectedPath: RegExp): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "compute.googleapis.com" || url.hostname === "www.googleapis.com") &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      expectedPath.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function ownershipMarker(ownership: ProviderOwnership): string {
  return [
    "intar-managed=true",
    `organization=${ownership.organizationRef}`,
    `connection=${ownership.connectionRef}`,
    `purpose=${ownership.purpose}`,
  ].join(";");
}

export function ownershipLabels(ownership: ProviderOwnership): Record<string, string> {
  const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_-]/gu, "_").slice(0, 63);
  const labels: Record<string, string> = {
    "intar-managed": "true",
    "intar-provider": "gcp-compute",
    "intar-org": normalized(ownership.organizationRef),
    "intar-connection": normalized(ownership.connectionRef),
    "intar-purpose": normalized(ownership.purpose),
  };
  if (ownership.workspaceRef) labels["intar-workspace"] = normalized(ownership.workspaceRef);
  if (ownership.generation !== undefined) labels["intar-generation"] = String(ownership.generation);
  if (ownership.workshopPublicationRef) {
    labels["intar-publication"] = normalized(ownership.workshopPublicationRef);
  }
  if (ownership.checkpointRef) labels["intar-checkpoint"] = normalized(ownership.checkpointRef);
  if (ownership.attempt !== undefined) labels["intar-attempt"] = String(ownership.attempt);
  return labels;
}

export function labelsMatchOwnership(
  labels: Record<string, string> | undefined,
  ownership: ProviderOwnership,
): boolean {
  const expected = ownershipLabels(ownership);
  return labels !== undefined && Object.entries(expected).every(([key, value]) => labels[key] === value);
}

function labelsMatchConnection(
  labels: Record<string, string> | undefined,
  ownership: ProviderOwnership,
): boolean {
  const expected = ownershipLabels(ownership);
  return labels !== undefined && [
    "intar-managed",
    "intar-provider",
    "intar-org",
    "intar-connection",
  ].every((name) => labels[name] === expected[name]);
}

function labelsMatchRuntimeResource(
  labels: Record<string, string> | undefined,
  ownership: ProviderOwnership,
): boolean {
  return labelsMatchConnection(labels, ownership) && (
    labels?.["intar-purpose"] === "learner_workspace" ||
    labels?.["intar-purpose"] === "workshop_publication_verifier"
  );
}

function ownedFoundationRoute(
  resource: GcpResourceRef,
  foundation: GcpFoundationSpec,
  networkOwned: boolean,
): boolean {
  return networkOwned &&
    resource.network?.endsWith(`/networks/${foundation.networkName}`) === true &&
    (
      resource.routeType === "SUBNET" ||
      (
        resource.routeType === "STATIC" &&
        resource.destRange === "0.0.0.0/0" &&
        resource.priority === 1_000 &&
        resource.nextHopGateway?.endsWith("/global/gateways/default-internet-gateway") === true &&
        (resource.tags?.length ?? 0) === 0
      )
    );
}

export function classifyOperationalInventory(
  inventory: GcpProjectInventory,
  foundation: GcpFoundationSpec,
  runtimeConnectionOwnership: ProviderOwnership,
): GcpOperationalInventoryClassification {
  const marker = ownershipMarker(foundation.ownership);
  const ownedFoundation = {
    network: new Set(inventory.networks
      .filter((resource) =>
        resource.name === foundation.networkName && resource.description === marker,
      )
      .map((resource) => resource.name)),
    subnetwork: new Set(inventory.subnetworks
      .filter((resource) =>
        resource.name === foundation.subnetworkName && resource.description === marker,
      )
      .map((resource) => resource.name)),
    firewall: new Set(inventory.firewalls
      .filter((resource) =>
        resource.name === foundation.firewallName && resource.description === marker,
      )
      .map((resource) => resource.name)),
  };
  const networkOwned = ownedFoundation.network.has(foundation.networkName);
  const ownedRoutes = new Set(inventory.routes
    .filter((resource) => ownedFoundationRoute(resource, foundation, networkOwned))
    .map((resource) => resource.name));
  const collections: Array<{
    resourceKind: GcpClassifiedInventoryResource["resourceKind"];
    resources: GcpResourceRef[];
    owned: (resource: GcpResourceRef) => boolean;
  }> = [
    { resourceKind: "instance", resources: inventory.instances, owned: (resource) =>
      labelsMatchRuntimeResource(resource.labels, runtimeConnectionOwnership) },
    { resourceKind: "disk", resources: inventory.disks, owned: (resource) =>
      labelsMatchRuntimeResource(resource.labels, runtimeConnectionOwnership) },
    { resourceKind: "address", resources: inventory.addresses, owned: () => false },
    { resourceKind: "snapshot", resources: inventory.snapshots, owned: () => false },
    { resourceKind: "image", resources: inventory.images, owned: () => false },
    { resourceKind: "instance_template", resources: inventory.instanceTemplates, owned: () => false },
    { resourceKind: "instance_group", resources: inventory.instanceGroups, owned: () => false },
    { resourceKind: "forwarding_rule", resources: inventory.forwardingRules, owned: () => false },
    { resourceKind: "target_pool", resources: inventory.targetPools, owned: () => false },
    { resourceKind: "backend_service", resources: inventory.backendServices, owned: () => false },
    { resourceKind: "network", resources: inventory.networks, owned: (resource) =>
      ownedFoundation.network.has(resource.name) },
    { resourceKind: "subnetwork", resources: inventory.subnetworks, owned: (resource) =>
      ownedFoundation.subnetwork.has(resource.name) },
    { resourceKind: "firewall", resources: inventory.firewalls, owned: (resource) =>
      ownedFoundation.firewall.has(resource.name) },
    { resourceKind: "route", resources: inventory.routes, owned: (resource) =>
      ownedRoutes.has(resource.name) },
  ];
  const ownedResources: GcpClassifiedInventoryResource[] = [];
  const foreignResources: GcpClassifiedInventoryResource[] = [];
  for (const collection of collections) {
    for (const resource of collection.resources) {
      (collection.owned(resource) ? ownedResources : foreignResources).push({
        resourceKind: collection.resourceKind,
        resource,
      });
    }
  }
  const ownedAssetNames = new Map<string, Set<string>>([
    ["compute.googleapis.com/Network", ownedFoundation.network],
    ["compute.googleapis.com/Subnetwork", ownedFoundation.subnetwork],
    ["compute.googleapis.com/Firewall", ownedFoundation.firewall],
    ["compute.googleapis.com/Route", ownedRoutes],
  ]);
  const ownedComputeAssets: GcpComputeAsset[] = [];
  const foreignComputeAssets: GcpComputeAsset[] = [];
  for (const asset of inventory.computeAssets) {
    const owned = asset.assetType === "compute.googleapis.com/Instance" ||
        asset.assetType === "compute.googleapis.com/Disk"
      ? labelsMatchRuntimeResource(asset.labels, runtimeConnectionOwnership)
      : ownedAssetNames.get(asset.assetType)?.has(asset.displayName) === true;
    (owned ? ownedComputeAssets : foreignComputeAssets).push(asset);
  }
  const foreignPresent = inventory.defaultNetworkPresent ||
    foreignResources.length > 0 || foreignComputeAssets.length > 0;
  const ownedPresent = ownedResources.length > 0 || ownedComputeAssets.length > 0;
  return {
    status: foreignPresent
      ? "foreign_resources_present"
      : ownedPresent
        ? "owned_resources_present"
        : "empty",
    ownedResources,
    foreignResources,
    ownedComputeAssets,
    foreignComputeAssets,
    defaultNetworkPresent: inventory.defaultNetworkPresent,
  };
}

export class GcpClient {
  readonly #projectId: string;
  readonly #serviceAccountEmail: string;
  readonly #api: GcpApi;

  constructor(key: GcpServiceAccountKey, projectId: string, options: GcpApiOptions = {}) {
    assertProject(projectId);
    if (key.project_id !== projectId) {
      throw new ProviderServiceError({
        code: "gcp_credential_project_mismatch",
        message: "GCP credential belongs to a different project",
        retryable: false,
      });
    }
    this.#projectId = projectId;
    this.#serviceAccountEmail = key.client_email;
    this.#api = new GcpApi(key, options);
  }

  async inspectIdentity(): Promise<GcpProjectIdentity> {
    const project = await this.#api.resourceManager<ProjectResponse>(`/projects/${this.#projectId}`);
    if (
      project.projectId !== this.#projectId ||
      !project.projectNumber ||
      project.lifecycleState !== "ACTIVE"
    ) {
      throw new ProviderServiceError({
        code: "gcp_project_unavailable",
        message: "GCP project is not active or does not match the credential",
        retryable: false,
      });
    }
    return {
      projectId: project.projectId,
      projectNumber: project.projectNumber,
      displayName: project.displayName ?? project.name ?? project.projectId,
      lifecycleState: project.lifecycleState,
      serviceAccountEmail: this.#serviceAccountEmail,
    };
  }

  async assertRequiredServices(projectNumber: string): Promise<string[]> {
    const enabled = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.#api.serviceUsage<ServiceListResponse>(
        `/projects/${projectNumber}/services`,
        {
          filter: "state:ENABLED",
          pageSize: "200",
          pageToken,
        },
      );
      for (const service of page.services ?? []) {
        const name = service.name?.split("/").at(-1);
        if (service.state === "ENABLED" && name) enabled.add(name);
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    const missing = REQUIRED_SERVICES.filter((service) => !enabled.has(service));
    if (missing.length > 0) {
      throw new ProviderServiceError({
        code: "gcp_required_api_disabled",
        message: "GCP project is missing required APIs",
        retryable: false,
      });
    }
    return [...enabled].sort();
  }

  async #assertIamPermissions(
    required: readonly string[],
    message: string,
  ): Promise<string[]> {
    const response = await this.#api.resourceManager<IamPermissionsResponse>(
      `/projects/${this.#projectId}:testIamPermissions`,
      {
        method: "POST",
        body: JSON.stringify({ permissions: required }),
      },
    );
    const granted = new Set(response.permissions ?? []);
    const missing = required.filter((permission) => !granted.has(permission));
    if (missing.length > 0) {
      throw new ProviderServiceError({
        code: "gcp_permission_missing",
        message,
        retryable: false,
      });
    }
    return [...granted].sort();
  }

  assertRequiredIamPermissions(): Promise<string[]> {
    return this.#assertIamPermissions(
      REQUIRED_IAM_PERMISSIONS,
      "GCP service account is missing required Workshop permissions",
    );
  }

  assertCleanupIamPermissions(): Promise<string[]> {
    return this.#assertIamPermissions(
      CLEANUP_IAM_PERMISSIONS,
      "GCP service account is missing required cleanup permissions",
    );
  }

  async assertMinimumQuotas(): Promise<GcpQuotaObservation[]> {
    const capacity = await this.observeCapacity({
      requestedSeats: 1,
      cpuPerSeat: 4,
      instancesPerSeat: 1,
      addressesPerSeat: 1,
      diskGibPerSeat: 32,
    });
    if (capacity.availableSeats < 1) {
      throw new ProviderServiceError({
        code: "gcp_quota_insufficient",
        message: "GCP project quota cannot provision the Workshop profile",
        retryable: false,
      });
    }
    return capacity.quotas;
  }

  async observeCapacity(input: {
    requestedSeats: number;
    cpuPerSeat: number;
    instancesPerSeat: 1;
    addressesPerSeat: 1;
    diskGibPerSeat: number;
  }): Promise<GcpQuotaCapacity> {
    if (
      !Number.isSafeInteger(input.requestedSeats) ||
      input.requestedSeats < 0 ||
      !Number.isSafeInteger(input.cpuPerSeat) ||
      input.cpuPerSeat < 1 ||
      !Number.isSafeInteger(input.diskGibPerSeat) ||
      input.diskGibPerSeat < 1
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP capacity requirements are invalid",
        retryable: false,
      });
    }
    const region = await this.#api.compute<ComputeRegionResponse>(
      `/projects/${this.#projectId}/regions/${WORKSHOP_REGION}`,
      undefined,
      { fields: "quotas" },
    );
    const quotas = (region.quotas ?? []).flatMap((quota): GcpQuotaObservation[] => {
      if (
        !quota.metric ||
        typeof quota.limit !== "number" || !Number.isFinite(quota.limit) ||
        typeof quota.usage !== "number" || !Number.isFinite(quota.usage)
      ) return [];
      return [{
        metric: quota.metric,
        limit: quota.limit,
        usage: quota.usage,
        available: Math.max(0, quota.limit - quota.usage),
      }];
    });
    const byMetric = new Map(quotas.map((quota) => [quota.metric, quota.available]));
    const requirements = [
      ["CPUS", input.cpuPerSeat],
      ["INSTANCES", input.instancesPerSeat],
      ["IN_USE_ADDRESSES", input.addressesPerSeat],
      ["SSD_TOTAL_GB", input.diskGibPerSeat],
    ] as const;
    const capacities = requirements.map(([metric, perSeat]) => {
      const available = byMetric.get(metric);
      return {
        metric,
        perSeat,
        seats:
          available === undefined
            ? 0
            : Math.max(0, Math.floor(available / perSeat)),
        available,
      };
    });
    const capacitySeats = Math.min(...capacities.map((entry) => entry.seats));
    const availableSeats = Math.min(input.requestedSeats, capacitySeats);
    const reasons = capacities.flatMap((entry) => {
      if (entry.available === undefined) {
        return [`GCP did not return the ${entry.metric} quota`];
      }
      const required = entry.perSeat * input.requestedSeats;
      return entry.available < required
        ? [
            `GCP ${entry.metric} quota has ${entry.available} remaining but ${required} is required`,
          ]
        : [];
    });
    return {
      quotas: quotas.sort((left, right) => left.metric.localeCompare(right.metric)),
      availableSeats,
      reasons,
    };
  }

  async #list(kind: string): Promise<GcpResourceRef[]> {
    const resources: GcpResourceRef[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#api.compute<ListResponse<ApiResource>>(
        `/projects/${this.#projectId}/global/${kind}`,
        undefined,
        { maxResults: "500", pageToken },
      );
      resources.push(...(page.items ?? []).map((item) => resourceRef(item)));
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    return resources;
  }

  async #aggregated(kind: string, itemKey: string): Promise<GcpResourceRef[]> {
    const resources: GcpResourceRef[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#api.compute<AggregatedListResponse<ApiResource>>(
        `/projects/${this.#projectId}/aggregated/${kind}`,
        undefined,
        { maxResults: "500", pageToken },
      );
      for (const [scope, scoped] of Object.entries(page.items ?? {})) {
        resources.push(...(scoped[itemKey] ?? []).map((item) => resourceRef(item, scope)));
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    return resources;
  }

  async #computeAssets(): Promise<GcpComputeAsset[]> {
    const assets: GcpComputeAsset[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#api.cloudAsset<CloudAssetSearchResponse>(
        `/projects/${this.#projectId}:searchAllResources`,
        {
          assetTypes: "compute.googleapis.com/.*",
          pageSize: "500",
          pageToken,
        },
      );
      for (const result of page.results ?? []) {
        if (
          !result.name ||
          !result.assetType?.startsWith("compute.googleapis.com/") ||
          !result.displayName ||
          !result.location
        ) {
          throw new ProviderServiceError({
            code: "gcp_invalid_response",
            message: "Cloud Asset Inventory returned an invalid Compute resource",
            retryable: false,
          });
        }
        assets.push({
          fullResourceName: result.name,
          assetType: result.assetType,
          displayName: result.displayName,
          location: result.location,
          ...(result.state ? { state: result.state } : {}),
          ...(result.labels ? { labels: result.labels } : {}),
        });
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    return assets.sort((left, right) => left.fullResourceName.localeCompare(right.fullResourceName));
  }

  async inventory(): Promise<GcpProjectInventory> {
    const [
      instances,
      disks,
      addresses,
      snapshots,
      images,
      instanceTemplates,
      instanceGroups,
      forwardingRules,
      targetPools,
      backendServices,
      networks,
      subnetworks,
      firewalls,
      routes,
      computeAssets,
    ] = await Promise.all([
      this.#aggregated("instances", "instances"),
      this.#aggregated("disks", "disks"),
      this.#aggregated("addresses", "addresses"),
      this.#list("snapshots"),
      this.#list("images"),
      this.#list("instanceTemplates"),
      this.#aggregated("instanceGroups", "instanceGroups"),
      this.#aggregated("forwardingRules", "forwardingRules"),
      this.#aggregated("targetPools", "targetPools"),
      this.#aggregated("backendServices", "backendServices"),
      this.#list("networks"),
      this.#aggregated("subnetworks", "subnetworks"),
      this.#list("firewalls"),
      this.#list("routes"),
      this.#computeAssets(),
    ]);
    return {
      instances,
      disks,
      addresses,
      snapshots,
      images,
      instanceTemplates,
      instanceGroups,
      forwardingRules,
      targetPools,
      backendServices,
      networks,
      subnetworks,
      firewalls,
      routes,
      computeAssets,
      defaultNetworkPresent: networks.some((network) => network.name === "default"),
    };
  }

  assertDedicatedProject(inventory: GcpProjectInventory, foundation?: GcpFoundationSpec): void {
    if (inventory.defaultNetworkPresent) {
      throw new ProviderServiceError({
        code: "gcp_default_vpc_present",
        message: "Delete the GCP default VPC before connecting this project",
        retryable: false,
      });
    }
    const alwaysForeign = [
      inventory.instances,
      inventory.disks,
      inventory.addresses,
      inventory.snapshots,
      inventory.images,
      inventory.instanceTemplates,
      inventory.instanceGroups,
      inventory.forwardingRules,
      inventory.targetPools,
      inventory.backendServices,
    ];
    if (alwaysForeign.some((resources) => resources.length > 0)) {
      throw new ProviderServiceError({
        code: "gcp_project_not_empty",
        message: "GCP project contains Compute resources",
        retryable: false,
      });
    }
    const allowedNetwork = foundation
      ? inventory.networks.filter((resource) => resource.name === foundation.networkName)
      : [];
    const allowedSubnet = foundation
      ? inventory.subnetworks.filter((resource) => resource.name === foundation.subnetworkName)
      : [];
    const allowedFirewall = foundation
      ? inventory.firewalls.filter((resource) => resource.name === foundation.firewallName)
      : [];
    const allowedRoutes = foundation
      ? inventory.routes.filter((resource) =>
          resource.network?.endsWith(`/networks/${foundation.networkName}`) &&
          (
            resource.routeType === "SUBNET" ||
            (
              resource.routeType === "STATIC" &&
              resource.destRange === "0.0.0.0/0" &&
              resource.priority === 1_000 &&
              resource.nextHopGateway?.endsWith("/global/gateways/default-internet-gateway") === true &&
              (resource.tags?.length ?? 0) === 0
            )
          ),
        )
      : [];
    const allowedAssetNames = new Map<string, Set<string>>();
    if (foundation) {
      allowedAssetNames.set("compute.googleapis.com/Network", new Set([foundation.networkName]));
      allowedAssetNames.set("compute.googleapis.com/Subnetwork", new Set([foundation.subnetworkName]));
      allowedAssetNames.set("compute.googleapis.com/Firewall", new Set([foundation.firewallName]));
      allowedAssetNames.set(
        "compute.googleapis.com/Route",
        new Set(allowedRoutes.map((route) => route.name)),
      );
    }
    const foreignAssets = inventory.computeAssets.filter((asset) =>
      !allowedAssetNames.get(asset.assetType)?.has(asset.displayName),
    );
    if (
      allowedNetwork.length !== inventory.networks.length ||
      allowedSubnet.length !== inventory.subnetworks.length ||
      allowedFirewall.length !== inventory.firewalls.length ||
      allowedRoutes.length !== inventory.routes.length ||
      foreignAssets.length > 0
    ) {
      throw new ProviderServiceError({
        code: "gcp_project_not_empty",
        message: "GCP project contains foreign Compute resources",
        retryable: false,
      });
    }
  }

  async resolveMachineTypes(machineType: string, zones: readonly string[]): Promise<GcpMachineType[]> {
    if (!/^[a-z][a-z0-9-]{1,62}$/u.test(machineType) || zones.some((zone) => !ZONE_PATTERN.test(zone))) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP machine profile is invalid",
        retryable: false,
      });
    }
    const machineTypes = await Promise.all(
      zones.map(async (zone): Promise<GcpMachineType> => {
        const value = await this.#api.compute<Record<string, unknown>>(
          `/projects/${this.#projectId}/zones/${zone}/machineTypes/${machineType}`,
        );
        if (
          typeof value.id !== "string" || value.name !== machineType ||
          typeof value.selfLink !== "string" || typeof value.guestCpus !== "number" ||
          typeof value.memoryMb !== "number" || typeof value.architecture !== "string"
        ) {
          throw new ProviderServiceError({
            code: "gcp_invalid_response",
            message: "GCP machine type response is invalid",
            retryable: false,
          });
        }
        return {
          id: value.id,
          name: machineType,
          selfLink: value.selfLink,
          zone,
          guestCpus: value.guestCpus,
          memoryMib: value.memoryMb,
          architecture: value.architecture,
          ...(typeof value.deprecated === "object" && value.deprecated !== null
            ? {
                deprecated: value.deprecated as NonNullable<
                  GcpMachineType["deprecated"]
                >,
              }
            : {}),
        };
      }),
    );
    if (machineTypes.some((type) => type.architecture !== "X86_64" || type.deprecated?.state === "DEPRECATED")) {
      throw new ProviderServiceError({
        code: "gcp_machine_type_unsupported",
        message: "GCP machine type is deprecated or not x86_64",
        retryable: false,
      });
    }
    return machineTypes;
  }

  async resolveImageFamily(imageFamily: string): Promise<GcpResolvedImage> {
    const match = /^projects\/([a-z0-9-]+)\/global\/images\/family\/([a-z0-9-]+)$/u.exec(imageFamily);
    if (!match) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP image family reference is invalid",
        retryable: false,
      });
    }
    const imageProject = match[1]!;
    const family = match[2]!;
    const value = await this.#api.compute<Record<string, unknown>>(
      `/projects/${imageProject}/global/images/family/${family}`,
    );
    if (
      typeof value.id !== "string" || typeof value.name !== "string" ||
      !/^[a-z0-9-]{1,63}$/u.test(value.name) ||
      typeof value.selfLink !== "string" || typeof value.architecture !== "string" ||
      typeof value.status !== "string" || typeof value.diskSizeGb !== "string" ||
      typeof value.creationTimestamp !== "string"
    ) {
      throw new ProviderServiceError({
        code: "gcp_invalid_response",
        message: "GCP image response is invalid",
        retryable: false,
      });
    }
    if (
      value.architecture !== "X86_64" ||
      value.status !== "READY" ||
      !validComputeSelfLink(
        value.selfLink,
        new RegExp(`^/compute/v1/projects/${imageProject}/global/images/${value.name}$`, "u"),
      ) ||
      (typeof value.deprecated === "object" && value.deprecated !== null)
    ) {
      throw new ProviderServiceError({
        code: "gcp_image_unsupported",
        message: "GCP system image is not a ready x86_64 image",
        retryable: false,
      });
    }
    return {
      id: value.id,
      name: value.name,
      selfLink: value.selfLink,
      family,
      architecture: value.architecture,
      status: value.status,
      diskSizeGb: value.diskSizeGb,
      creationTimestamp: value.creationTimestamp,
      ...(typeof value.deprecated === "object" && value.deprecated !== null
        ? {
            deprecated: value.deprecated as NonNullable<
              GcpResolvedImage["deprecated"]
            >,
          }
        : {}),
    };
  }

  async observeResource(selfLink: string): Promise<GcpResourceRef | null> {
    let parsed: URL;
    try {
      parsed = new URL(selfLink);
    } catch {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP resource reference is invalid",
        retryable: false,
      });
    }
    const prefix = `/compute/v1/projects/${this.#projectId}/`;
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "compute.googleapis.com" && parsed.hostname !== "www.googleapis.com") ||
      parsed.username !== "" || parsed.password !== "" || parsed.port !== "" ||
      parsed.search !== "" || parsed.hash !== "" ||
      !parsed.pathname.startsWith(prefix)
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP resource reference is invalid",
        retryable: false,
      });
    }
    return this.#getOptional(parsed.pathname.slice("/compute/v1".length));
  }

  async #getOptional(path: string): Promise<GcpResourceRef | null> {
    try {
      return resourceRef(await this.#api.compute<ApiResource>(path));
    } catch (error) {
      if (error instanceof GcpApiError && error.shape.code === "gcp_not_found") return null;
      throw error;
    }
  }

  async #ownedBootDisk(
    zone: string,
    name: string,
    ownership: ProviderOwnership,
  ): Promise<GcpResourceRef | null> {
    const disk = await this.#getOptional(
      `/projects/${this.#projectId}/zones/${zone}/disks/${name}`,
    );
    if (disk && (disk.name !== name || !labelsMatchOwnership(disk.labels, ownership))) {
      throw new ProviderServiceError({
        code: "gcp_allocation_ownership_mismatch",
        message: "GCP allocation name belongs to another resource",
        retryable: false,
      });
    }
    return disk;
  }

  async #createAndWait(
    path: string,
    body: Record<string, unknown>,
    requestParts: readonly string[],
  ): Promise<GcpAsyncOperation> {
    const requestId = await deterministicRequestId(requestParts);
    const operation = await this.#api.compute<GcpAsyncOperation>(
      path,
      { method: "POST", body: JSON.stringify(body) },
      { requestId },
    );
    const settled = await this.#api.waitForOperation(this.#projectId, operation);
    if (settled.status !== "DONE") {
      throw new ProviderServiceError({
        code: "gcp_operation_pending",
        message: "GCP foundation operation is still running",
        retryable: true,
      });
    }
    return settled;
  }

  async ensureFoundation(foundation: GcpFoundationSpec): Promise<GcpFoundationObservation> {
    if (
      foundation.subnetworkRegion !== "europe-west3" ||
      !foundation.subnetworkCidr.startsWith("10.") ||
      !validIpv4Cidr(foundation.subnetworkCidr, 24) ||
      ![foundation.networkName, foundation.subnetworkName, foundation.firewallName]
        .every((name) => RESOURCE_NAME_PATTERN.test(name)) ||
      foundation.stargateEgressIpv4Cidrs.length === 0 ||
      foundation.stargateEgressIpv4Cidrs.some((cidr) => !validIpv4Cidr(cidr, 32))
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP foundation specification is invalid",
        retryable: false,
      });
    }
    const createdResourceSelfLinks: string[] = [];
    const marker = ownershipMarker(foundation.ownership);
    const networkPath = `/projects/${this.#projectId}/global/networks/${foundation.networkName}`;
    let network = await this.#getOptional(networkPath);
    if (!network) {
      await this.#createAndWait(
        `/projects/${this.#projectId}/global/networks`,
        {
          name: foundation.networkName,
          description: marker,
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: "REGIONAL" },
        },
        [this.#projectId, foundation.networkName, "create-network"],
      );
      network = await this.#getOptional(networkPath);
      if (network) createdResourceSelfLinks.push(network.selfLink);
    }
    if (!network || network.description !== marker) {
      throw new ProviderServiceError({
        code: "gcp_foundation_ownership_mismatch",
        message: "GCP network sentinel ownership does not match",
        retryable: false,
      });
    }

    const region = foundation.subnetworkRegion;
    const subnetPath = `/projects/${this.#projectId}/regions/${region}/subnetworks/${foundation.subnetworkName}`;
    let subnetwork = await this.#getOptional(subnetPath);
    if (!subnetwork) {
      await this.#createAndWait(
        `/projects/${this.#projectId}/regions/${region}/subnetworks`,
        {
          name: foundation.subnetworkName,
          description: marker,
          network: network.selfLink,
          ipCidrRange: foundation.subnetworkCidr,
          privateIpGoogleAccess: false,
          stackType: "IPV4_ONLY",
        },
        [this.#projectId, foundation.subnetworkName, "create-subnetwork"],
      );
      subnetwork = await this.#getOptional(subnetPath);
      if (subnetwork) createdResourceSelfLinks.push(subnetwork.selfLink);
    }
    if (!subnetwork || subnetwork.description !== marker) {
      throw new ProviderServiceError({
        code: "gcp_foundation_ownership_mismatch",
        message: "GCP subnet sentinel ownership does not match",
        retryable: false,
      });
    }

    const firewallPath = `/projects/${this.#projectId}/global/firewalls/${foundation.firewallName}`;
    let firewall = await this.#getOptional(firewallPath);
    if (!firewall) {
      await this.#createAndWait(
        `/projects/${this.#projectId}/global/firewalls`,
        {
          name: foundation.firewallName,
          description: marker,
          network: network.selfLink,
          direction: "INGRESS",
          priority: 1000,
          sourceRanges: foundation.stargateEgressIpv4Cidrs,
          targetTags: ["intar-learner"],
          allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
          disabled: false,
        },
        [this.#projectId, foundation.firewallName, "create-firewall"],
      );
      firewall = await this.#getOptional(firewallPath);
      if (firewall) createdResourceSelfLinks.push(firewall.selfLink);
    }
    if (!firewall || firewall.description !== marker) {
      throw new ProviderServiceError({
        code: "gcp_foundation_ownership_mismatch",
        message: "GCP firewall sentinel ownership does not match",
        retryable: false,
      });
    }
    return { network, subnetwork, firewall, createdResourceSelfLinks };
  }

  async createInstance(operation: CreateGcpInstanceOperation): Promise<{
    operation: GcpAsyncOperation;
    requestId: string;
  }> {
    if (
      !RESOURCE_NAME_PATTERN.test(operation.name) || !ZONE_PATTERN.test(operation.zone) ||
      operation.rootDiskType !== "pd-balanced" || operation.rootDiskGib < 10 ||
      operation.rootDiskGib > 65_536 || operation.startupScript.length > 256 * 1024 ||
      operation.sshPublicKey.length > 8_192 ||
      !/^ssh-(?:ed25519|rsa) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,256})?$/u.test(operation.sshPublicKey) ||
      !validComputeSelfLink(
        operation.sourceImage,
        /^\/compute\/v1\/projects\/[a-z0-9-]+\/global\/images\/[a-z0-9-]+$/u,
      ) ||
      !validComputeSelfLink(
        operation.networkSelfLink,
        new RegExp(`^/compute/v1/projects/${this.#projectId}/global/networks/intar-[a-z0-9-]+$`, "u"),
      ) ||
      !validComputeSelfLink(
        operation.subnetworkSelfLink,
        new RegExp(`^/compute/v1/projects/${this.#projectId}/regions/europe-west3/subnetworks/intar-[a-z0-9-]+$`, "u"),
      ) ||
      operation.generation < 1
    ) {
      throw new ProviderServiceError({
        code: "invalid_provider_request",
        message: "GCP instance specification is invalid",
        retryable: false,
      });
    }
    const requestId = await deterministicRequestId([
      this.#projectId,
      operation.name,
      String(operation.generation),
      "create-instance",
    ]);
    const apiOperation = await this.#api.compute<GcpAsyncOperation>(
      `/projects/${this.#projectId}/zones/${operation.zone}/instances`,
      {
        method: "POST",
        body: JSON.stringify({
          name: operation.name,
          description: ownershipMarker(operation.ownership),
          machineType: `zones/${operation.zone}/machineTypes/${operation.machineType}`,
          labels: ownershipLabels(operation.ownership),
          tags: { items: ["intar-learner"] },
          canIpForward: false,
          deletionProtection: false,
          disks: [
            {
              boot: true,
              autoDelete: true,
              type: "PERSISTENT",
              initializeParams: {
                diskName: operation.name,
                sourceImage: operation.sourceImage,
                diskSizeGb: String(operation.rootDiskGib),
                diskType: `zones/${operation.zone}/diskTypes/${operation.rootDiskType}`,
                labels: ownershipLabels(operation.ownership),
              },
            },
          ],
          networkInterfaces: [
            {
              network: operation.networkSelfLink,
              subnetwork: operation.subnetworkSelfLink,
              stackType: "IPV4_ONLY",
              accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
            },
          ],
          metadata: {
            items: [
              { key: "block-project-ssh-keys", value: "TRUE" },
              { key: "ssh-keys", value: `intar:${operation.sshPublicKey}` },
              { key: "startup-script", value: operation.startupScript },
            ],
          },
          serviceAccounts: [],
          shieldedInstanceConfig: {
            enableSecureBoot: false,
            enableVtpm: true,
            enableIntegrityMonitoring: true,
          },
        }),
      },
      { requestId },
    );
    return { operation: apiOperation, requestId };
  }

  async advanceInstance(
    operation: CreateGcpInstanceOperation,
  ): Promise<GcpInstanceAdvanceResult> {
    try {
      const created = await this.createInstance(operation);
      return { outcome: "created", ...created };
    } catch (error) {
      if (
        !(error instanceof ProviderServiceError) ||
        error.shape.code !== "gcp_transport_error"
      ) throw error;
      const requestId = await deterministicRequestId([
        this.#projectId,
        operation.name,
        String(operation.generation),
        "create-instance",
      ]);
      const observation = await this.observeAllocation(
        operation.zone,
        operation.name,
        operation.ownership,
      );
      if (observation.status === "present") {
        return { outcome: "reconciled", requestId, observation };
      }
      if (observation.status === "ownership_mismatch") {
        throw new ProviderServiceError({
          code: "gcp_allocation_ownership_mismatch",
          message: "GCP allocation name belongs to another resource",
          retryable: false,
        });
      }
      // GCP ignores a repeated insert with the same requestId. Retrying only
      // after name-based reconciliation therefore cannot create a second VM.
      const retried = await this.createInstance(operation);
      return { outcome: "created", ...retried };
    }
  }

  observeOperation(operationSelfLink: string): Promise<GcpAsyncOperation> {
    return this.#api.getOperation(this.#projectId, operationSelfLink);
  }

  async observeAllocation(
    zone: string,
    instanceName: string,
    ownership: ProviderOwnership,
    bootDiskName = instanceName,
  ): Promise<GcpAllocationObservation> {
    assertAllocationIdentity(zone, instanceName);
    assertAllocationIdentity(zone, bootDiskName);
    const path = `/projects/${this.#projectId}/zones/${zone}/instances/${instanceName}`;
    let instance: ApiInstance;
    try {
      instance = await this.#api.compute<ApiInstance>(path);
    } catch (error) {
      if (error instanceof GcpApiError && error.shape.code === "gcp_not_found") {
        const bootDisk = await this.#ownedBootDisk(zone, bootDiskName, ownership);
        return { instance: null, bootDisk, status: "missing" };
      }
      throw error;
    }
    const instanceRef = resourceRef(instance);
    if (!labelsMatchOwnership(instance.labels, ownership)) {
      return { instance: instanceRef, bootDisk: null, status: "ownership_mismatch" };
    }
    const diskLink = instance.disks?.find((disk) => disk.boot)?.source;
    let bootDisk: GcpResourceRef | null = null;
    if (diskLink) {
      if (!validComputeSelfLink(
        diskLink,
        new RegExp(
          `^/compute/v1/projects/${this.#projectId}/zones/${zone}/disks/${bootDiskName}$`,
          "u",
        ),
      )) {
        throw new ProviderServiceError({
          code: "gcp_invalid_response",
          message: "GCP API returned a foreign boot disk reference",
          retryable: false,
        });
      }
      bootDisk = await this.#ownedBootDisk(zone, bootDiskName, ownership);
    }
    const publicIpv4 = instance.networkInterfaces
      ?.flatMap((network) => network.accessConfigs ?? [])
      .find((config) => config.type === "ONE_TO_ONE_NAT")?.natIP;
    return {
      instance: instanceRef,
      bootDisk,
      ...(publicIpv4 ? { publicIpv4 } : {}),
      status: "present",
    };
  }

  async rebootInstance(
    zone: string,
    instanceName: string,
    ownership: ProviderOwnership,
  ): Promise<GcpAsyncOperation> {
    assertAllocationIdentity(zone, instanceName);
    const path = `/projects/${this.#projectId}/zones/${zone}/instances/${instanceName}`;
    const instance = await this.#api.compute<ApiInstance>(path);
    resourceRef(instance);
    if (!labelsMatchOwnership(instance.labels, ownership)) {
      throw new ProviderServiceError({
        code: "gcp_allocation_ownership_mismatch",
        message: "GCP allocation name belongs to another resource",
        retryable: false,
      });
    }
    const requestId = await deterministicRequestId([this.#projectId, zone, instanceName, "reset"]);
    return this.#api.compute<GcpAsyncOperation>(
      `${path}/reset`,
      { method: "POST", body: "{}" },
      { requestId },
    );
  }

  async deleteInstance(
    zone: string,
    instanceName: string,
    ownership: ProviderOwnership,
  ): Promise<GcpAsyncOperation | null> {
    assertAllocationIdentity(zone, instanceName);
    const path = `/projects/${this.#projectId}/zones/${zone}/instances/${instanceName}`;
    let instance: ApiInstance;
    try {
      instance = await this.#api.compute<ApiInstance>(path);
    } catch (error) {
      if (error instanceof GcpApiError && error.shape.code === "gcp_not_found") return null;
      throw error;
    }
    resourceRef(instance);
    if (!labelsMatchOwnership(instance.labels, ownership)) {
      throw new ProviderServiceError({
        code: "gcp_allocation_ownership_mismatch",
        message: "GCP allocation name belongs to another resource",
        retryable: false,
      });
    }
    const requestId = await deterministicRequestId([this.#projectId, zone, instanceName, "delete"]);
    try {
      return await this.#api.compute<GcpAsyncOperation>(
        path,
        { method: "DELETE" },
        { requestId },
      );
    } catch (error) {
      if (error instanceof GcpApiError && error.shape.code === "gcp_not_found") return null;
      throw error;
    }
  }

  async deleteDisk(
    zone: string,
    diskName: string,
    ownership: ProviderOwnership,
  ): Promise<GcpAsyncOperation | null> {
    assertAllocationIdentity(zone, diskName);
    const path = `/projects/${this.#projectId}/zones/${zone}/disks/${diskName}`;
    let disk: ApiResource;
    try {
      disk = await this.#api.compute<ApiResource>(path);
    } catch (error) {
      if (error instanceof GcpApiError && error.shape.code === "gcp_not_found") return null;
      throw error;
    }
    resourceRef(disk);
    if (!labelsMatchOwnership(disk.labels, ownership)) {
      throw new ProviderServiceError({
        code: "gcp_allocation_ownership_mismatch",
        message: "GCP boot disk name belongs to another resource",
        retryable: false,
      });
    }
    const requestId = await deterministicRequestId([
      this.#projectId,
      zone,
      diskName,
      "delete-disk",
    ]);
    try {
      return await this.#api.compute<GcpAsyncOperation>(
        path,
        { method: "DELETE" },
        { requestId },
      );
    } catch (error) {
      if (error instanceof GcpApiError && error.shape.code === "gcp_not_found") return null;
      throw error;
    }
  }

  async sweep(ownership: ProviderOwnership): Promise<{
    instances: GcpResourceRef[];
    disks: GcpResourceRef[];
    addresses: GcpResourceRef[];
  }> {
    const [instances, disks, addresses] = await Promise.all([
      this.#aggregated("instances", "instances"),
      this.#aggregated("disks", "disks"),
      this.#aggregated("addresses", "addresses"),
    ]);
    const owned = (resources: GcpResourceRef[]) =>
      resources.filter((resource) => labelsMatchOwnership(resource.labels, ownership));
    return { instances: owned(instances), disks: owned(disks), addresses: owned(addresses) };
  }
}
