import { describe, expect, it, vi } from "vitest";
import type {
  ConnectGcpProjectRequest,
  GcpCredentialContext,
  GcpOperationalConnectionInspection,
  GcpServiceAccountKey,
  RotateGcpCredentialRequest,
  RunGcpOperationRequest,
} from "@intar/provider-contracts/gcp";
import { sealGcpCredential } from "../src/credential";
import {
  CLEANUP_IAM_PERMISSIONS,
  ownershipLabels,
  ownershipMarker,
  REQUIRED_IAM_PERMISSIONS,
} from "../src/gcp-client";
import {
  connectProject,
  providerReadiness,
  rotateCredential,
  runOperation,
} from "../src/provider";

const context = {
  organizationId: "org_0123456789",
  connectionId: "conn_0123456789",
  credentialId: "cred_0123456789",
  provider: "gcp_compute",
  version: 1,
} satisfies GcpCredentialContext;

const key = {
  type: "service_account",
  project_id: "intar-empty-12345",
  private_key_id: "0123456789abcdef",
  private_key: "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
  client_email: "intar-runtime@intar-empty-12345.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
} satisfies GcpServiceAccountKey;

const ownership = {
  organizationRef: "org_0123456789",
  connectionRef: "conn_0123456789",
  purpose: "learner_workspace",
  workspaceRef: "workspace_0123456789",
  generation: 1,
} as const;

const foundationOwnership = {
  organizationRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  connectionRef: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  purpose: "provider_connection_sentinel",
} as const;

function connectRequest(): ConnectGcpProjectRequest {
  return {
    requestId: "connect-project-0001",
    connectionId: context.connectionId,
    credentialContext: context,
    serviceAccountKeyJson: JSON.stringify(key),
    projectId: key.project_id,
    permittedZones: ["europe-west3-a"],
    requiredMachineTypes: ["e2-standard-4"],
    imageFamily: "projects/debian-cloud/global/images/family/debian-13",
    foundation: {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.77.0.0/20",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["192.0.2.10/32"],
      ownership: foundationOwnership,
    },
  };
}

function kek(): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(23)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function effectiveFirewallPayload(unsafeIngress = false) {
  const foundation = connectRequest().foundation;
  const networkSelfLink =
    `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
    `global/networks/${foundation.networkName}`;
  return {
    firewalls: [{
      name: foundation.firewallName,
      direction: "INGRESS",
      disabled: false,
      sourceRanges: foundation.stargateEgressIpv4Cidrs,
      sourceTags: [],
      sourceServiceAccounts: [],
      targetTags: ["intar-learner"],
      targetServiceAccounts: [],
      allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
    }],
    firewallPolicys: [{
      name: "organizations/123/firewallPolicies/456",
      type: "HIERARCHY",
      rules: [{
        action: "allow",
        direction: "INGRESS",
        disabled: false,
        targetType: "INSTANCES",
        targetResources: [networkSelfLink],
        targetServiceAccounts: [],
        targetSecureTags: [],
        match: {
          srcIpRanges: unsafeIngress
            ? ["0.0.0.0/0"]
            : foundation.stargateEgressIpv4Cidrs,
          layer4Configs: [{ ipProtocol: "tcp", ports: ["22"] }],
        },
      }],
    }],
  };
}

function foundationRoutePayload(
  failure?: "missing_default" | "competing",
) {
  const foundation = connectRequest().foundation;
  const network =
    `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
    `global/networks/${foundation.networkName}`;
  const items: Array<Record<string, unknown>> = [{
    id: "route-subnet-1",
    name: "intar-subnet-route",
    selfLink:
      `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
      "global/routes/intar-subnet-route",
    network,
    routeType: "SUBNET",
    destRange: foundation.subnetworkCidr,
    priority: 0,
    tags: [],
  }];
  if (failure !== "missing_default") {
    items.push({
      id: "route-default-1",
      name: "default-route-internet",
      selfLink:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
        "global/routes/default-route-internet",
      network,
      routeType: "STATIC",
      destRange: "0.0.0.0/0",
      priority: 1_000,
      tags: [],
      nextHopGateway:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
        "global/gateways/default-internet-gateway",
    });
  }
  if (failure === "competing") {
    items.push({
      id: "route-custom-1",
      name: "learner-custom-default",
      selfLink:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
        "global/routes/learner-custom-default",
      network,
      routeType: "STATIC",
      destRange: "0.0.0.0/0",
      priority: 900,
      tags: ["intar-learner"],
    });
  }
  return { items };
}

function managementApi(options: {
  includeOwnedAllocation?: boolean;
  includeForeignAllocation?: boolean;
  includeForeignComputeAsset?: boolean;
  wrongFoundationMarker?: boolean;
  permissions?: readonly string[];
  activeReady?: boolean;
  activeFailure?:
    | "billing"
    | "api"
    | "iam"
    | "quota"
    | "foundation"
    | "effective_firewall"
    | "route";
  missingFoundation?: boolean;
  routeFailure?: "missing_default" | "competing";
  projectAsset?: "exact" | "mismatched" | "duplicate" | "none";
} = {}) {
  const requests: Array<{ method: string; pathname: string }> = [];
  const tokenProvider = vi.fn(async () => ({
    accessToken: "management-token",
    expiresAtEpochSeconds: 4_000_000_000,
  }));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, pathname: url.pathname });
    if (
      url.hostname === "cloudresourcemanager.googleapis.com" &&
      url.pathname.endsWith(":testIamPermissions")
    ) {
      const permissions = options.activeFailure === "iam"
        ? REQUIRED_IAM_PERMISSIONS.slice(1)
        : options.permissions ?? CLEANUP_IAM_PERMISSIONS;
      return Response.json({ permissions });
    }
    if (url.hostname === "cloudresourcemanager.googleapis.com") {
      return Response.json({
        projectId: key.project_id,
        projectNumber: "123456789012",
        displayName: "Intar cleanup project",
        lifecycleState: "ACTIVE",
      });
    }
    if (url.hostname === "serviceusage.googleapis.com") {
      const services = [
        "compute.googleapis.com",
        "cloudbilling.googleapis.com",
        "cloudresourcemanager.googleapis.com",
        "serviceusage.googleapis.com",
        "cloudasset.googleapis.com",
      ].filter((service) =>
        options.activeFailure !== "api" || service !== "cloudbilling.googleapis.com"
      );
      return Response.json({ services: services.map((service) => ({
        name: `projects/123456789012/services/${service}`,
        state: "ENABLED",
      })) });
    }
    if (
      url.hostname === "cloudbilling.googleapis.com" &&
      url.pathname.endsWith(`/projects/${key.project_id}/billingInfo`)
    ) {
      return Response.json({
        name: `projects/${key.project_id}/billingInfo`,
        projectId: key.project_id,
        billingAccountName: options.activeFailure === "billing"
          ? ""
          : "billingAccounts/ABCDEF-123456-ABCDEF",
        billingEnabled: options.activeFailure !== "billing",
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/regions/europe-west3")
    ) {
      const available = options.activeReady && options.activeFailure !== "quota";
      return Response.json({ quotas: [
        { metric: "CPUS", limit: 4, usage: available ? 0 : 4 },
        { metric: "INSTANCES", limit: 1, usage: available ? 0 : 1 },
        { metric: "IN_USE_ADDRESSES", limit: 1, usage: available ? 0 : 1 },
        { metric: "SSD_TOTAL_GB", limit: 32, usage: available ? 0 : 32 },
      ] });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/getEffectiveFirewalls")
    ) {
      return Response.json(effectiveFirewallPayload(
        options.activeFailure === "effective_firewall",
      ));
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/global/routes")
    ) {
      return Response.json(foundationRoutePayload(
        options.activeFailure === "route"
          ? "competing"
          : options.routeFailure,
      ));
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/global/networks/intar-network-main")
    ) {
      if (options.missingFoundation) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      return Response.json({
        id: "network-1001",
        name: "intar-network-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/networks/intar-network-main",
        description: options.wrongFoundationMarker
          ? "intar-managed=true;organization=other;connection=other;purpose=provider_connection_sentinel"
          : ownershipMarker(foundationOwnership),
        autoCreateSubnetworks: false,
        routingConfig: { routingMode: "REGIONAL" },
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith(
        "/regions/europe-west3/subnetworks/intar-subnet-main",
      )
    ) {
      return Response.json({
        id: "subnetwork-1001",
        name: "intar-subnet-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/regions/europe-west3/subnetworks/intar-subnet-main",
        description: ownershipMarker(foundationOwnership),
        network:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/networks/intar-network-main",
        region:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/regions/europe-west3",
        ipCidrRange: "10.77.0.0/20",
        privateIpGoogleAccess: false,
        stackType: "IPV4_ONLY",
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/global/firewalls/intar-firewall-main")
    ) {
      return Response.json({
        id: "firewall-1001",
        name: "intar-firewall-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/firewalls/intar-firewall-main",
        description: ownershipMarker(foundationOwnership),
        network:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/networks/intar-network-main",
        direction: "INGRESS",
        priority: 1_000,
        sourceRanges: ["192.0.2.10/32"],
        sourceTags: options.activeFailure === "foundation" ? ["broadened"] : [],
        targetTags: ["intar-learner"],
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        disabled: false,
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/global/networks")
    ) {
      return Response.json({ items: [{
        id: "network-1001",
        name: "intar-network-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/networks/intar-network-main",
        description: options.wrongFoundationMarker
          ? "intar-managed=true;organization=other;connection=other;purpose=provider_connection_sentinel"
          : ownershipMarker(foundationOwnership),
      }] });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/aggregated/subnetworks")
    ) {
      return Response.json({ items: { "regions/europe-west3": { subnetworks: [{
        id: "subnetwork-1001",
        name: "intar-subnet-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/regions/europe-west3/subnetworks/intar-subnet-main",
        description: options.wrongFoundationMarker
          ? "intar-managed=true;organization=other;connection=other;purpose=provider_connection_sentinel"
          : ownershipMarker(foundationOwnership),
      }] } } });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/global/firewalls")
    ) {
      return Response.json({ items: [{
        id: "firewall-1001",
        name: "intar-firewall-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/firewalls/intar-firewall-main",
        description: options.wrongFoundationMarker
          ? "intar-managed=true;organization=other;connection=other;purpose=provider_connection_sentinel"
          : ownershipMarker(foundationOwnership),
      }] });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/aggregated/instances")
    ) {
      const instances = [];
      if (options.includeOwnedAllocation) instances.push({
        id: "instance-owned",
        name: "intar-learner-owned",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/zones/europe-west3-a/instances/intar-learner-owned",
        labels: ownershipLabels(ownership),
      });
      if (options.includeForeignAllocation) instances.push({
        id: "instance-foreign",
        name: "foreign-instance",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/zones/europe-west3-a/instances/foreign-instance",
        labels: { "intar-managed": "true", "intar-org": "other" },
      });
      return Response.json({
        items: { "zones/europe-west3-a": { instances } },
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/aggregated/disks")
    ) {
      return Response.json({
        items: { "zones/europe-west3-a": { disks: options.includeOwnedAllocation ? [{
          id: "disk-owned",
          name: "intar-learner-owned",
          selfLink:
            `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
            "/zones/europe-west3-a/disks/intar-learner-owned",
          labels: ownershipLabels(ownership),
        }] : [] } },
      });
    }
    if (url.hostname === "cloudasset.googleapis.com") {
      const projectAsset = {
        name: `//compute.googleapis.com/projects/${key.project_id}`,
        assetType: "compute.googleapis.com/Project",
      };
      const results: Array<Record<string, unknown>> = [];
      if (options.projectAsset !== "none") {
        results.push(options.projectAsset === "mismatched"
          ? {
              name: "//compute.googleapis.com/projects/other-project-12345",
              assetType: "compute.googleapis.com/Project",
            }
          : projectAsset);
      }
      if (options.projectAsset === "duplicate") results.push(projectAsset);
      if (options.includeForeignComputeAsset) {
        results.push({
          name:
            `//compute.googleapis.com/projects/${key.project_id}/global/` +
            "healthChecks/foreign-health-check",
          assetType: "compute.googleapis.com/HealthCheck",
          displayName: "foreign-health-check",
          location: "global",
        });
      }
      return Response.json({ results });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.includes("/machineTypes/e2-standard-4")
    ) {
      const zone = /\/zones\/([^/]+)\//u.exec(url.pathname)?.[1];
      return Response.json({
        id: `machine-${zone}`,
        name: "e2-standard-4",
        selfLink: `${url.origin}${url.pathname}`,
        guestCpus: 4,
        memoryMb: 16_384,
        architecture: "X86_64",
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/images/family/debian-13")
    ) {
      return Response.json({
        id: "image-1301",
        name: "debian-13-trixie-v20260801",
        selfLink:
          "https://compute.googleapis.com/compute/v1/projects/debian-cloud/" +
          "global/images/debian-13-trixie-v20260801",
        architecture: "X86_64",
        status: "READY",
        diskSizeGb: "10",
        creationTimestamp: "2026-08-01T00:00:00.000Z",
      });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/images/debian-13-trixie-v20260701")
    ) {
      return Response.json({
        id: "image-1300",
        name: "debian-13-trixie-v20260701",
        selfLink:
          "https://compute.googleapis.com/compute/v1/projects/debian-cloud/" +
          "global/images/debian-13-trixie-v20260701",
        architecture: "X86_64",
        status: "READY",
        diskSizeGb: "10",
        creationTimestamp: "2026-07-01T00:00:00.000Z",
      });
    }
    if (url.hostname === "compute.googleapis.com") {
      return Response.json({});
    }
    throw new Error(`Unhandled management request ${request.method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, requests, tokenProvider };
}

function catalogSku(
  skuId: string,
  description: string,
  resourceGroup: string,
  usageUnit: string,
) {
  const isExternalIpv4 = skuId === "C054-7F72-A02E";
  return {
    skuId,
    description,
    category: { resourceFamily: "Compute", resourceGroup, usageType: "OnDemand" },
    serviceRegions: isExternalIpv4 ? [] : ["europe-west3"],
    ...(isExternalIpv4
      ? { geoTaxonomy: { type: "GLOBAL", regions: [] } }
      : {}),
    pricingInfo: [{
      pricingExpression: {
        usageUnit,
        tieredRates: [{
          startUsageAmount: 0,
          unitPrice: { currencyCode: "USD", units: "0", nanos: 1_000_000 },
        }],
      },
    }],
  };
}

describe("GCP provider deployment mode", () => {
  it("reports dormant readiness without any network access", async () => {
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog fetch must not run");
    }) as unknown as typeof fetch;

    await expect(providerReadiness(
      { mode: "dormant" },
      { catalog: { fetcher: catalogFetch } },
    )).resolves.toEqual({
      mode: "dormant",
      readyForNewWork: false,
      catalog: { checked: false },
    });
    expect(catalogFetch).not.toHaveBeenCalled();
  });

  it("proves active readiness with a live catalog quote", async () => {
    const catalogFetch = vi.fn(async () => Response.json({ skus: [
      catalogSku("C921-088E-792A", "E2 Instance Core running in Frankfurt", "CPU", "h"),
      catalogSku("7D80-F9E4-6A44", "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h"),
      catalogSku("B1B5-0BAA-CB31", "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo"),
      catalogSku("C054-7F72-A02E", "External IP Charge on a Standard VM", "IP", "h"),
    ] })) as unknown as typeof fetch;

    await expect(providerReadiness(
      { mode: "active", catalogApiKey: "catalog-key-01234567890123456789" },
      {
        catalog: {
          fetcher: catalogFetch,
          now: () => new Date("2026-08-01T10:00:00.000Z"),
        },
      },
    )).resolves.toEqual({
      mode: "active",
      readyForNewWork: true,
      catalog: {
        checked: true,
        observedAt: "2026-08-01T10:00:00.000Z",
        lineItemCount: 4,
      },
    });
    expect(catalogFetch).toHaveBeenCalledTimes(1);
  });

  it("validates a pinned image without following the mutable family head", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const api = managementApi({
      activeReady: true,
      permissions: REQUIRED_IAM_PERMISSIONS,
    });
    const pinnedImage =
      "https://compute.googleapis.com/compute/v1/projects/debian-cloud/" +
      "global/images/debian-13-trixie-v20260701";

    const result = await runOperation(
      {
        requestId: "resolve-pinned-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "resolve_profile",
          machineType: "e2-standard-4",
          zones: ["europe-west3-a"],
          imageFamily: "projects/debian-cloud/global/images/family/debian-13",
          resolvedImageId: pinnedImage,
        },
      },
      kek(),
      { mode: "active", catalogApiKey: "catalog-key-01234567890123456789" },
      { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
    );

    expect(result.data).toMatchObject({
      resolvedImage: {
        name: "debian-13-trixie-v20260701",
        selfLink: pinnedImage,
      },
    });
    expect(api.requests.some(({ pathname }) =>
      pathname.endsWith("/images/debian-13-trixie-v20260701"),
    )).toBe(true);
    expect(api.requests.some(({ pathname }) =>
      pathname.endsWith("/images/family/debian-13"),
    )).toBe(false);
  });

  it("blocks an explicitly dormant connection before any GCP or catalog call", async () => {
    const providerFetch = vi.fn(async () => {
      throw new Error("provider fetch must not run");
    }) as unknown as typeof fetch;
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog fetch must not run");
    }) as unknown as typeof fetch;
    const tokenProvider = vi.fn(async () => ({
      accessToken: "must-not-be-used",
      expiresAtEpochSeconds: 4_000_000_000,
    }));

    await expect(connectProject(
      connectRequest(),
      kek(),
      { mode: "dormant", catalogApiKey: "catalog-key-01234567890123456789" },
      { api: { fetcher: providerFetch, tokenProvider }, catalog: { fetcher: catalogFetch } },
    )).rejects.toMatchObject({ shape: { code: "gcp_provider_dormant", retryable: false } });
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(catalogFetch).not.toHaveBeenCalled();
  });

  it("does not infer dormant mode from a missing catalog key", async () => {
    const providerFetch = vi.fn(async () => {
      throw new Error("provider fetch must not run");
    }) as unknown as typeof fetch;
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog fetch must not run");
    }) as unknown as typeof fetch;
    const tokenProvider = vi.fn(async () => ({
      accessToken: "must-not-be-used",
      expiresAtEpochSeconds: 4_000_000_000,
    }));

    await expect(connectProject(
      connectRequest(),
      kek(),
      { mode: "active" },
      { api: { fetcher: providerFetch, tokenProvider }, catalog: { fetcher: catalogFetch } },
    )).rejects.toMatchObject({
      shape: { code: "gcp_catalog_configuration_invalid", retryable: false },
    });
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(catalogFetch).not.toHaveBeenCalled();
  });

  it("connects when CAI returns only the inherent project asset", async () => {
    const api = managementApi({
      activeReady: true,
      permissions: REQUIRED_IAM_PERMISSIONS,
    });
    const catalogFetch = vi.fn(async () => Response.json({ skus: [
      catalogSku("C921-088E-792A", "E2 Instance Core running in Frankfurt", "CPU", "h"),
      catalogSku("7D80-F9E4-6A44", "E2 Instance Ram running in Frankfurt", "RAM", "GiBy.h"),
      catalogSku("B1B5-0BAA-CB31", "Balanced PD Capacity in Frankfurt", "PdBalanced", "GiBy.mo"),
      catalogSku("C054-7F72-A02E", "External IP Charge on a Standard VM", "IP", "h"),
    ] })) as unknown as typeof fetch;

    const result = await connectProject(
      connectRequest(),
      kek(),
      { mode: "active", catalogApiKey: "catalog-key-01234567890123456789" },
      {
        api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider },
        catalog: {
          fetcher: catalogFetch,
          now: () => new Date("2026-08-01T10:00:00.000Z"),
        },
        now: () => new Date("2026-08-01T10:00:00.000Z"),
      },
    );

    expect(result.identity.projectId).toBe(key.project_id);
    expect(result.inventory.computeAssets).toEqual([{
      fullResourceName: `//compute.googleapis.com/projects/${key.project_id}`,
      assetType: "compute.googleapis.com/Project",
      displayName: key.project_id,
      location: "global",
    }]);
    expect(result.foundation).toMatchObject({
      network: { name: "intar-network-main" },
      subnetwork: { name: "intar-subnet-main" },
      firewall: { name: "intar-firewall-main" },
      createdResourceSelfLinks: [],
    });
  });

  it("blocks instance creation with no catalog key before provider mutation", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const providerFetch = vi.fn(async () => {
      throw new Error("provider fetch must not run");
    }) as unknown as typeof fetch;
    const tokenProvider = vi.fn(async () => ({
      accessToken: "must-not-be-used",
      expiresAtEpochSeconds: 4_000_000_000,
    }));
    const request = {
      requestId: "create-instance-0001",
      connectionId: context.connectionId,
      credentialContext: context,
      credential,
      projectId: key.project_id,
      operation: {
        kind: "create_instance",
        name: "intar-learner-abc",
        zone: "europe-west3-a",
        machineType: "e2-standard-4",
        sourceImage: "projects/debian-cloud/global/images/debian-13-amd64-20260701",
        rootDiskType: "pd-balanced",
        rootDiskGib: 32,
        networkSelfLink: "https://compute.googleapis.com/compute/v1/projects/p/global/networks/n",
        subnetworkSelfLink:
          "https://compute.googleapis.com/compute/v1/projects/p/regions/europe-west3/subnetworks/s",
        cloudInit: "#cloud-config\nruncmd:\n  - [true]\n",
        ownership,
        generation: 1,
      },
    } satisfies RunGcpOperationRequest;

    await expect(runOperation(
      request,
      kek(),
      { mode: "active" },
      { api: { fetcher: providerFetch, tokenProvider } },
    )).rejects.toMatchObject({
      shape: { code: "gcp_catalog_configuration_invalid", retryable: false },
    });
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("gates every setup and planning operation before provider access", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const providerFetch = vi.fn(async () => {
      throw new Error("provider fetch must not run");
    }) as unknown as typeof fetch;
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog fetch must not run");
    }) as unknown as typeof fetch;
    const tokenProvider = vi.fn(async () => ({
      accessToken: "must-not-be-used",
      expiresAtEpochSeconds: 4_000_000_000,
    }));
    const operations: RunGcpOperationRequest["operation"][] = [
      {
        kind: "resolve_profile",
        machineType: "e2-standard-4",
        zones: ["europe-west3-a"],
        imageFamily: "projects/debian-cloud/global/images/family/debian-13",
      },
      {
        kind: "quote",
        machineType: "e2-standard-4",
        zones: ["europe-west3-a"],
        rootDiskType: "pd-balanced",
        rootDiskGib: 32,
      },
      {
        kind: "preflight_capacity",
        machineType: "e2-standard-4",
        zones: ["europe-west3-a"],
        rootDiskType: "pd-balanced",
        rootDiskGib: 32,
        requestedSeats: 1,
      },
      { kind: "ensure_foundation", foundation: connectRequest().foundation },
    ];

    for (const [index, operation] of operations.entries()) {
      await expect(runOperation(
        {
          requestId: `blocked-operation-${index}`,
          connectionId: context.connectionId,
          credentialContext: context,
          credential,
          projectId: key.project_id,
          operation,
        },
        kek(),
        { mode: "active" },
        {
          api: { fetcher: providerFetch, tokenProvider },
          catalog: { fetcher: catalogFetch },
        },
      )).rejects.toMatchObject({
        shape: { code: "gcp_catalog_configuration_invalid", retryable: false },
      });
    }
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(catalogFetch).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown deployment mode before a provider call", async () => {
    const providerFetch = vi.fn(async () => {
      throw new Error("provider fetch must not run");
    }) as unknown as typeof fetch;
    const tokenProvider = vi.fn(async () => ({
      accessToken: "must-not-be-used",
      expiresAtEpochSeconds: 4_000_000_000,
    }));

    await expect(connectProject(
      connectRequest(),
      kek(),
      { mode: "unexpected" },
      { api: { fetcher: providerFetch, tokenProvider } },
    )).rejects.toMatchObject({ shape: { code: "gcp_provider_mode_invalid" } });
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("keeps read-only connection inspection available without catalog access", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const api = managementApi({ includeOwnedAllocation: true });
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog fetch must not run");
    }) as unknown as typeof fetch;
    const result = await runOperation(
      {
        requestId: "inspect-connection-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "inspect_connection",
          foundation: connectRequest().foundation,
          zones: ["europe-west3-a"],
        },
      },
      kek(),
      { mode: "dormant" },
      {
        api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider },
        catalog: { fetcher: catalogFetch },
      },
    );

    const data = result.data as GcpOperationalConnectionInspection;
    expect(data).toMatchObject({
      identity: { projectId: key.project_id },
      inventory: { defaultNetworkPresent: false },
      validation: {
        authority: "cleanup_only",
        grantedCleanupPermissions: CLEANUP_IAM_PERMISSIONS,
      },
      classification: { status: "owned_resources_present" },
    });
    expect(CLEANUP_IAM_PERMISSIONS).toContain("serviceusage.services.use");
    expect(CLEANUP_IAM_PERMISSIONS).not.toContain("compute.instances.create");
    expect(data.classification.ownedResources.map(({ resourceKind }) => resourceKind))
      .toEqual(expect.arrayContaining(["instance", "disk", "network", "subnetwork", "firewall"]));
    expect(data.classification.foreignResources).toEqual([]);
    expect(data.classification.ownedComputeAssets).toEqual([]);
    expect(data.classification.foreignComputeAssets).toEqual([]);
    expect(data.inventory.computeAssets).toEqual([expect.objectContaining({
      fullResourceName: `//compute.googleapis.com/projects/${key.project_id}`,
      assetType: "compute.googleapis.com/Project",
    })]);
    expect(result.canonicalWrites).toEqual([]);
    expect(api.tokenProvider).toHaveBeenCalledTimes(1);
    expect(catalogFetch).not.toHaveBeenCalled();
    expect(api.requests.filter(({ method, pathname }) =>
      method !== "GET" && !pathname.endsWith(":testIamPermissions"),
    )).toEqual([]);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/regions/europe-west3")))
      .toBe(false);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/services"))).toBe(false);
  });

  it("runs the full active connection inspection without mutations", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const api = managementApi({
      activeReady: true,
      permissions: REQUIRED_IAM_PERMISSIONS,
      includeOwnedAllocation: true,
    });
    const result = await runOperation(
      {
        requestId: "inspect-active-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "inspect_connection",
          foundation: connectRequest().foundation,
          zones: ["europe-west3-a"],
        },
      },
      kek(),
      { mode: "active" },
      { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
    );

    const data = result.data as GcpOperationalConnectionInspection;
    expect(data.validation).toMatchObject({
      authority: "active",
      billing: { billingEnabled: true },
      machineTypes: [{ name: "e2-standard-4", zone: "europe-west3-a" }],
      resolvedImage: { name: "debian-13-trixie-v20260801" },
      foundation: { createdResourceSelfLinks: [] },
    });
    expect(data.classification).toMatchObject({
      status: "owned_resources_present",
      ownedResources: expect.arrayContaining([
        expect.objectContaining({ resourceKind: "instance" }),
        expect.objectContaining({ resourceKind: "disk" }),
      ]),
      foreignResources: [],
      ownedComputeAssets: [],
      foreignComputeAssets: [],
    });
    expect(data.inventory.computeAssets).toEqual([expect.objectContaining({
      fullResourceName: `//compute.googleapis.com/projects/${key.project_id}`,
      assetType: "compute.googleapis.com/Project",
    })]);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/services"))).toBe(true);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/regions/europe-west3")))
      .toBe(true);
    expect(api.requests.some(({ pathname }) => pathname.includes("/zones/europe-west3-b/")))
      .toBe(false);
    expect(api.requests.filter(({ method, pathname }) =>
      method !== "GET" && !pathname.endsWith(":testIamPermissions"),
    )).toEqual([]);
  });

  it("validates the exact existing foundation in dormant mode without writes", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const api = managementApi();
    const result = await runOperation(
      {
        requestId: "validate-foundation-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "validate_foundation",
          foundation: connectRequest().foundation,
        },
      },
      kek(),
      { mode: "dormant" },
      { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
    );

    expect(result.data).toMatchObject({
      network: { name: "intar-network-main" },
      subnetwork: { name: "intar-subnet-main" },
      firewall: { name: "intar-firewall-main" },
      createdResourceSelfLinks: [],
    });
    expect(result.canonicalWrites).toEqual([]);
    expect(result.mustPersistBeforeNextOperation).toBe(false);
    expect(api.requests).toHaveLength(6);
    expect(api.requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("rejects missing or drifted foundation through the read-only operation", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    for (const options of [
      { missingFoundation: true },
      { activeFailure: "foundation" as const },
      { activeFailure: "effective_firewall" as const },
      { routeFailure: "missing_default" as const },
      { routeFailure: "competing" as const },
    ]) {
      const api = managementApi(options);
      await expect(runOperation(
        {
          requestId: options.missingFoundation
            ? "validate-foundation-missing"
            : options.activeFailure === "effective_firewall"
              ? "validate-foundation-effective"
              : options.routeFailure === "missing_default"
                ? "validate-foundation-route-missing"
                : options.routeFailure === "competing"
                  ? "validate-foundation-route-competing"
                  : "validate-foundation-drifted",
          connectionId: context.connectionId,
          credentialContext: context,
          credential,
          projectId: key.project_id,
          operation: {
            kind: "validate_foundation",
            foundation: connectRequest().foundation,
          },
        },
        kek(),
        { mode: "dormant" },
        { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
      )).rejects.toMatchObject({
        shape: {
          code: options.missingFoundation
            ? "gcp_foundation_ownership_mismatch"
            : "gcp_foundation_drift",
        },
      });
      expect(api.requests.every(({ method }) => method === "GET")).toBe(true);
    }
  });

  it("fails active inspection on every issuance prerequisite without mutations", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const failures = [
      ["billing", "gcp_billing_disabled"],
      ["api", "gcp_required_api_disabled"],
      ["iam", "gcp_permission_missing"],
      ["quota", "gcp_quota_insufficient"],
      ["foundation", "gcp_foundation_drift"],
      ["effective_firewall", "gcp_foundation_drift"],
      ["route", "gcp_foundation_drift"],
    ] as const;

    for (const [activeFailure, code] of failures) {
      const api = managementApi({
        activeReady: true,
        activeFailure,
        permissions: REQUIRED_IAM_PERMISSIONS,
      });
      await expect(runOperation(
        {
          requestId: `inspect-failure-${activeFailure}`,
          connectionId: context.connectionId,
          credentialContext: context,
          credential,
          projectId: key.project_id,
          operation: {
            kind: "inspect_connection",
            foundation: connectRequest().foundation,
            zones: ["europe-west3-a"],
          },
        },
        kek(),
        { mode: "active" },
        { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
      )).rejects.toMatchObject({ shape: { code } });
      expect(api.requests.filter(({ method, pathname }) =>
        method !== "GET" && !pathname.endsWith(":testIamPermissions"),
      )).toEqual([]);
    }
  });

  it("rejects foreign live resources and unclassified Compute assets in active inspection", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    for (const foreign of [
      { includeForeignAllocation: true },
      { includeForeignComputeAsset: true },
      { projectAsset: "mismatched" as const },
      { projectAsset: "duplicate" as const },
    ]) {
      const api = managementApi({
        ...foreign,
        activeReady: true,
        permissions: REQUIRED_IAM_PERMISSIONS,
      });
      await expect(runOperation(
        {
          requestId: foreign.includeForeignAllocation
            ? "inspect-foreign-instance"
            : foreign.includeForeignComputeAsset
              ? "inspect-foreign-asset"
              : foreign.projectAsset === "mismatched"
                ? "inspect-mismatched-project-asset"
                : "inspect-duplicate-project-asset",
          connectionId: context.connectionId,
          credentialContext: context,
          credential,
          projectId: key.project_id,
          operation: {
            kind: "inspect_connection",
            foundation: connectRequest().foundation,
            zones: ["europe-west3-a"],
          },
        },
        kek(),
        { mode: "active" },
        { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
      )).rejects.toMatchObject({ shape: { code: "gcp_project_not_empty" } });
      expect(api.requests.filter(({ method, pathname }) =>
        method !== "GET" && !pathname.endsWith(":testIamPermissions"),
      )).toEqual([]);
    }
  });

  it("returns owned and foreign cleanup inventory without connect-time rejection", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const api = managementApi({
      includeOwnedAllocation: true,
      includeForeignAllocation: true,
      wrongFoundationMarker: true,
    });
    const result = await runOperation(
      {
        requestId: "inspect-connection-foreign-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "inspect_connection",
          foundation: connectRequest().foundation,
          zones: ["europe-west3-a"],
        },
      },
      kek(),
      { mode: "dormant" },
      { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
    );
    const data = result.data as GcpOperationalConnectionInspection;

    expect(data.classification.status).toBe("foreign_resources_present");
    expect(data.classification.ownedResources.map(({ resourceKind }) => resourceKind))
      .toEqual(expect.arrayContaining(["instance", "disk"]));
    expect(data.classification.foreignResources.map(({ resourceKind }) => resourceKind))
      .toEqual(expect.arrayContaining(["instance", "network", "subnetwork", "firewall"]));
    expect(result.canonicalWrites).toEqual([]);
    expect(api.requests.filter(({ method, pathname }) =>
      method !== "GET" && !pathname.endsWith(":testIamPermissions"),
    )).toEqual([]);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/regions/europe-west3")))
      .toBe(false);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/services"))).toBe(false);
  });

  it("keeps credential rotation available without enabling issuance", async () => {
    const api = managementApi();
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog fetch must not run");
    }) as unknown as typeof fetch;
    const request = {
      requestId: "rotate-credential-0001",
      connectionId: context.connectionId,
      credentialContext: { ...context, version: 2 },
      serviceAccountKeyJson: JSON.stringify(key),
      projectId: key.project_id,
      sentinelNetworkSelfLink:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
        "/global/networks/intar-network-main",
      ownership: foundationOwnership,
    } satisfies RotateGcpCredentialRequest;
    const result = await rotateCredential(
      request,
      kek(),
      { mode: "dormant" },
      {
        api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider },
        catalog: { fetcher: catalogFetch },
      },
    );

    expect(result.identity.projectId).toBe(key.project_id);
    expect(result.authority).toBe("cleanup_only");
    expect(result.sentinelNetwork).toMatchObject({
      id: "network-1001",
      name: "intar-network-main",
    });
    expect(result.credential).toMatchObject({
      algorithm: "AES-256-GCM",
      createdAt: expect.any(String),
    });
    expect(api.tokenProvider).toHaveBeenCalledTimes(1);
    expect(catalogFetch).not.toHaveBeenCalled();
    expect(api.requests.filter(({ method, pathname }) =>
      method !== "GET" && !pathname.endsWith(":testIamPermissions"),
    )).toEqual([]);
    expect(api.requests.some(({ pathname }) => pathname.includes("/instances"))).toBe(false);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/regions/europe-west3")))
      .toBe(false);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/services"))).toBe(false);
  });

  it("requires full issuance IAM for active-mode rotation without checking quota", async () => {
    const api = managementApi({ permissions: REQUIRED_IAM_PERMISSIONS });
    const request = {
      requestId: "rotate-credential-active-0001",
      connectionId: context.connectionId,
      credentialContext: { ...context, version: 3 },
      serviceAccountKeyJson: JSON.stringify(key),
      projectId: key.project_id,
      sentinelNetworkSelfLink:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
        "/global/networks/intar-network-main",
      ownership: foundationOwnership,
    } satisfies RotateGcpCredentialRequest;
    const result = await rotateCredential(
      request,
      kek(),
      { mode: "active" },
      { api: { fetcher: api.fetcher, tokenProvider: api.tokenProvider } },
    );

    expect(result.authority).toBe("active");
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/services"))).toBe(true);
    expect(api.requests.some(({ pathname }) => pathname.endsWith("/regions/europe-west3")))
      .toBe(false);
    expect(api.requests.some(({ pathname }) => pathname.includes("/instances"))).toBe(false);
  });
});

describe("GCP provider allocation observation", () => {
  it("carries provider creation times into all allocation writes", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const instanceCreatedAt = "2026-08-01T10:00:10.000Z";
    const diskCreatedAt = "2026-08-01T10:00:11.000Z";
    const instancePath =
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/` +
      "instances/intar-learner-abc";
    const diskPath =
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/` +
      "disks/intar-learner-abc";
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === instancePath) {
        return Response.json({
          id: "instance-9001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
          status: "RUNNING",
          zone: "europe-west3-a",
          creationTimestamp: instanceCreatedAt,
          disks: [{ boot: true, source: `${url.origin}${diskPath}` }],
          networkInterfaces: [{
            accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "192.0.2.8" }],
          }],
        });
      }
      if (url.pathname === diskPath) {
        return Response.json({
          id: "disk-9001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
          status: "READY",
          zone: "europe-west3-a",
          creationTimestamp: diskCreatedAt,
        });
      }
      throw new Error(`Unhandled GET ${url.pathname}`);
    }) as typeof fetch;
    const result = await runOperation(
      {
        requestId: "observe-allocation-created-at",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "observe_allocation",
          zone: "europe-west3-a",
          instanceName: "intar-learner-abc",
          bootDiskName: "intar-learner-abc",
          ownership,
        },
      },
      kek(),
      { mode: "dormant" },
      {
        api: {
          fetcher,
          tokenProvider: async () => ({
            accessToken: "token",
            expiresAtEpochSeconds: 4_000_000_000,
          }),
        },
      },
    );

    expect(result.data).toMatchObject({
      instance: { creationTimestamp: instanceCreatedAt },
      bootDisk: { creationTimestamp: diskCreatedAt },
    });
    expect(result.canonicalWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceKind: "instance",
        resourceCreatedAt: instanceCreatedAt,
      }),
      expect.objectContaining({
        resourceKind: "boot_disk",
        resourceCreatedAt: diskCreatedAt,
      }),
      expect.objectContaining({
        resourceKind: "ipv4",
        resourceCreatedAt: instanceCreatedAt,
      }),
    ]));
  });

  it("exposes owned orphan-disk deletion to the generic cleanup harness", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const methods: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      methods.push(request.method);
      if (request.method === "GET") {
        return Response.json({
          id: "disk-9001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
        });
      }
      return Response.json({
        id: "operation-delete-disk-1",
        name: "delete-disk-1",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/zones/europe-west3-a/operations/delete-disk-1",
        status: "PENDING",
      });
    }) as typeof fetch;
    const result = await runOperation(
      {
        requestId: "delete-disk-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "delete_disk",
          zone: "europe-west3-a",
          diskName: "intar-learner-abc",
          ownership,
        },
      },
      kek(),
      { mode: "dormant" },
      {
        api: {
          fetcher,
          tokenProvider: async () => ({
            accessToken: "token",
            expiresAtEpochSeconds: 4_000_000_000,
          }),
        },
      },
    );

    expect(methods).toEqual(["GET", "DELETE"]);
    expect(result.canonicalWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "resource_deletion_requested",
        resourceKind: "boot_disk",
        name: "intar-learner-abc",
      }),
    ]));
  });

  it("keeps an orphan boot disk active until its independent GET returns 404", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    let diskPresent = true;
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      paths.push(url.pathname);
      if (url.pathname.endsWith("/instances/intar-learner-abc")) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      if (url.pathname.endsWith("/disks/intar-learner-abc")) {
        return diskPresent
          ? Response.json({
              id: "disk-9001",
              name: "intar-learner-abc",
              selfLink: `${url.origin}${url.pathname}`,
              labels: ownershipLabels(ownership),
              status: "READY",
              zone: "europe-west3-a",
            })
          : Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      throw new Error(`Unhandled GET ${url.pathname}`);
    }) as typeof fetch;
    const request = {
      requestId: "observe-allocation-0001",
      connectionId: context.connectionId,
      credentialContext: context,
      credential,
      projectId: key.project_id,
      operation: {
        kind: "observe_allocation",
        zone: "europe-west3-a",
        instanceName: "intar-learner-abc",
        bootDiskName: "intar-learner-abc",
        ownership,
      },
    } satisfies RunGcpOperationRequest;
    const options = {
      api: {
        fetcher,
        tokenProvider: async () => ({
          accessToken: "token",
          expiresAtEpochSeconds: 4_000_000_000,
        }),
      },
      now: () => new Date("2026-08-01T10:01:00.000Z"),
    };

    const orphaned = await runOperation(request, kek(), { mode: "dormant" }, options);
    expect(orphaned.data).toMatchObject({
      status: "missing",
      instance: null,
      bootDisk: { id: "disk-9001", name: "intar-learner-abc" },
    });
    expect(orphaned.canonicalWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "instance",
        name: "intar-learner-abc",
      }),
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "ipv4",
        name: "intar-learner-abc-ephemeral-ipv4",
      }),
      expect.objectContaining({
        operation: "resource_observed",
        resourceKind: "boot_disk",
        externalId: "disk-9001",
      }),
    ]));

    diskPresent = false;
    const deleted = await runOperation(
      { ...request, requestId: "observe-allocation-0002" },
      kek(),
      { mode: "dormant" },
      options,
    );
    expect(deleted.canonicalWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "boot_disk",
        externalId: "intar-learner-abc",
        name: "intar-learner-abc",
      }),
    ]));
    expect(paths).toEqual([
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/instances/intar-learner-abc`,
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/disks/intar-learner-abc`,
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/instances/intar-learner-abc`,
      `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/disks/intar-learner-abc`,
    ]);
  });

  it("does not close a boot disk on a transient disk lookup while the instance still exists", async () => {
    const credential = await sealGcpCredential(
      JSON.stringify(key),
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    const instancePath = `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/instances/intar-learner-abc`;
    const diskPath = `/compute/v1/projects/${key.project_id}/zones/europe-west3-a/disks/intar-learner-abc`;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === instancePath) {
        return Response.json({
          id: "instance-9001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
          status: "RUNNING",
          zone: "europe-west3-a",
          disks: [{ boot: true, source: `${url.origin}${diskPath}` }],
          networkInterfaces: [],
        });
      }
      if (url.pathname === diskPath) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      throw new Error(`Unhandled GET ${url.pathname}`);
    }) as typeof fetch;
    const result = await runOperation(
      {
        requestId: "observe-allocation-0003",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        projectId: key.project_id,
        operation: {
          kind: "observe_allocation",
          zone: "europe-west3-a",
          instanceName: "intar-learner-abc",
          bootDiskName: "intar-learner-abc",
          ownership,
        },
      },
      kek(),
      { mode: "dormant" },
      {
        api: {
          fetcher,
          tokenProvider: async () => ({
            accessToken: "token",
            expiresAtEpochSeconds: 4_000_000_000,
          }),
        },
        now: () => new Date("2026-08-01T10:01:00.000Z"),
      },
    );
    expect(result.canonicalWrites).toEqual([
      expect.objectContaining({
        operation: "resource_observed",
        resourceKind: "instance",
        externalId: "instance-9001",
      }),
    ]);
  });
});
