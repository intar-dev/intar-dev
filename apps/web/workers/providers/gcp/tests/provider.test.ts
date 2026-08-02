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
import { connectProject, rotateCredential, runOperation } from "../src/provider";

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
      subnetworkCidr: "10.42.0.0/24",
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

function managementApi(options: {
  includeOwnedAllocation?: boolean;
  includeForeignAllocation?: boolean;
  wrongFoundationMarker?: boolean;
  permissions?: readonly string[];
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
      return Response.json({ permissions: options.permissions ?? CLEANUP_IAM_PERMISSIONS });
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
      return Response.json({ services: [
        "compute.googleapis.com",
        "cloudresourcemanager.googleapis.com",
        "serviceusage.googleapis.com",
        "cloudasset.googleapis.com",
      ].map((service) => ({
        name: `projects/123456789012/services/${service}`,
        state: "ENABLED",
      })) });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/regions/europe-west3")
    ) {
      return Response.json({ quotas: [
        { metric: "CPUS", limit: 4, usage: 4 },
        { metric: "INSTANCES", limit: 1, usage: 1 },
        { metric: "IN_USE_ADDRESSES", limit: 1, usage: 1 },
        { metric: "SSD_TOTAL_GB", limit: 32, usage: 32 },
      ] });
    }
    if (
      url.hostname === "compute.googleapis.com" &&
      url.pathname.endsWith("/global/networks/intar-network-main")
    ) {
      return Response.json({
        id: "network-1001",
        name: "intar-network-main",
        selfLink:
          `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
          "/global/networks/intar-network-main",
        description: options.wrongFoundationMarker
          ? "intar-managed=true;organization=other;connection=other;purpose=provider_connection_sentinel"
          : ownershipMarker(foundationOwnership),
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
      return Response.json({ results: [] });
    }
    if (url.hostname === "compute.googleapis.com") {
      return Response.json({});
    }
    throw new Error(`Unhandled management request ${request.method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, requests, tokenProvider };
}

describe("GCP provider deployment mode", () => {
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
        sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake intar",
        startupScript: "#!/bin/sh\nexit 0\n",
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
        operation: { kind: "inspect_connection", foundation: connectRequest().foundation },
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
      classification: { status: "owned_resources_present" },
    });
    expect(data.classification.ownedResources.map(({ resourceKind }) => resourceKind))
      .toEqual(expect.arrayContaining(["instance", "disk", "network", "subnetwork", "firewall"]));
    expect(data.classification.foreignResources).toEqual([]);
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
        operation: { kind: "inspect_connection", foundation: connectRequest().foundation },
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
