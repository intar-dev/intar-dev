import { describe, expect, it } from "vitest";
import type {
  GcpFoundationSpec,
  GcpProjectInventory,
  GcpServiceAccountKey,
} from "@intar/provider-contracts/gcp";
import { GcpClient, ownershipLabels } from "../src/gcp-client";

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

function emptyInventory(): GcpProjectInventory {
  return {
    instances: [], disks: [], addresses: [], snapshots: [], images: [],
    instanceTemplates: [], instanceGroups: [], forwardingRules: [],
    targetPools: [], backendServices: [], networks: [], subnetworks: [],
    firewalls: [], routes: [], computeAssets: [], defaultNetworkPresent: false,
  };
}

function instanceInput() {
  return {
    kind: "create_instance",
    name: "intar-learner-abc",
    zone: "europe-west3-a",
    machineType: "e2-standard-4",
    sourceImage: "https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/debian-13-20260701",
    rootDiskType: "pd-balanced",
    rootDiskGib: 32,
    networkSelfLink: "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/global/networks/intar-network-main",
    subnetworkSelfLink: "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/regions/europe-west3/subnetworks/intar-subnet-main",
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest intar",
    startupScript: "#!/bin/sh\ntrue\n",
    ownership,
    generation: 1,
  } as const;
}

describe("GcpClient", () => {
  it("uses a deterministic requestId and the locked-down learner instance contract", async () => {
    const requests: Request[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        id: "7001",
        name: "operation-7001",
        selfLink: "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/zones/europe-west3-a/operations/operation-7001",
        status: "PENDING",
        targetId: "8001",
        targetLink: "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/zones/europe-west3-a/instances/intar-learner-abc",
      });
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      computeBase: "https://compute.googleapis.com/compute/v1",
      tokenProvider: async () => ({ accessToken: "test-access-token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    const input = instanceInput();
    const first = await client.createInstance(input);
    const second = await client.createInstance(input);
    expect(first.requestId).toBe(second.requestId);
    expect(first.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(new URL(requests[0]!.url).searchParams.get("requestId")).toBe(first.requestId);
    const body = await requests[0]!.clone().json<Record<string, unknown>>();
    expect(body).toHaveProperty("serviceAccounts", []);
    expect(body).not.toHaveProperty("networkInterfaces.0.ipv6AccessConfigs");
    expect(body).toMatchObject({
      canIpForward: false,
      deletionProtection: false,
      tags: { items: ["intar-learner"] },
    });
    expect(body.disks).toHaveLength(1);
    expect(body.networkInterfaces).toHaveLength(1);
    expect(body).toMatchObject({
      networkInterfaces: [{
        stackType: "IPV4_ONLY",
        accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
      }],
      metadata: { items: expect.arrayContaining([
        { key: "block-project-ssh-keys", value: "TRUE" },
        { key: "ssh-keys", value: expect.stringContaining("ssh-ed25519") },
      ]) },
      disks: [{
        boot: true,
        autoDelete: true,
        initializeParams: {
          diskName: "intar-learner-abc",
          diskSizeGb: "32",
          labels: ownershipLabels(ownership),
        },
      }],
    });
    expect(JSON.stringify(body)).not.toContain("natIP");
    expect(JSON.stringify(body)).not.toContain("ipv6AccessConfigs");
    expect(JSON.stringify(body)).not.toContain("externalIpv6");
  });

  it("blocks a default VPC and any foreign Compute resource", () => {
    const client = new GcpClient(key, key.project_id, {
      tokenProvider: async () => ({ accessToken: "unused", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    expect(() => client.assertDedicatedProject({
      ...emptyInventory(),
      networks: [{ id: "1", name: "default", selfLink: "https://compute.test/default" }],
      defaultNetworkPresent: true,
    })).toThrow("Delete the GCP default VPC");
    expect(() => client.assertDedicatedProject({
      ...emptyInventory(),
      instances: [{ id: "1", name: "foreign", selfLink: "https://compute.test/foreign" }],
    })).toThrow("GCP project contains Compute resources");
    for (const inventory of [
      { disks: [{ id: "2", name: "foreign", selfLink: "https://compute.test/disk" }] },
      { addresses: [{ id: "3", name: "foreign", selfLink: "https://compute.test/ip" }] },
      { snapshots: [{ id: "4", name: "foreign", selfLink: "https://compute.test/snapshot" }] },
      { images: [{ id: "5", name: "foreign", selfLink: "https://compute.test/image" }] },
      { instanceTemplates: [{ id: "6", name: "foreign", selfLink: "https://compute.test/template" }] },
      { forwardingRules: [{ id: "7", name: "foreign", selfLink: "https://compute.test/rule" }] },
    ] satisfies Array<Partial<GcpProjectInventory>>) {
      expect(() => client.assertDedicatedProject({ ...emptyInventory(), ...inventory }))
        .toThrow("GCP project contains Compute resources");
    }
  });

  it("allows only the deterministic foundation during a connection retry", () => {
    const client = new GcpClient(key, key.project_id, {
      tokenProvider: async () => ({ accessToken: "unused", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    const foundation = {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.42.0.0/24",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      ownership: {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "provider_connection_sentinel",
      },
    } satisfies GcpFoundationSpec;
    const allowed = {
      ...emptyInventory(),
      networks: [{ id: "1", name: foundation.networkName, selfLink: "https://compute.test/network" }],
      subnetworks: [{ id: "2", name: foundation.subnetworkName, selfLink: "https://compute.test/subnet" }],
      firewalls: [{ id: "3", name: foundation.firewallName, selfLink: "https://compute.test/firewall" }],
      routes: [{
        id: "4",
        name: "default-route-abcd",
        selfLink: "https://compute.test/route",
        routeType: "SUBNET",
        network: `https://compute.test/networks/${foundation.networkName}`,
      }, {
        id: "5",
        name: "default-route-internet",
        selfLink: "https://compute.test/default-internet",
        routeType: "STATIC",
        network: `https://compute.test/networks/${foundation.networkName}`,
        destRange: "0.0.0.0/0",
        priority: 1_000,
        nextHopGateway: "https://compute.test/global/gateways/default-internet-gateway",
        tags: [],
      }],
    };
    expect(() => client.assertDedicatedProject(allowed, foundation)).not.toThrow();
    expect(() => client.assertDedicatedProject({
      ...allowed,
      networks: [...allowed.networks, { id: "9", name: "foreign", selfLink: "https://compute.test/foreign" }],
    }, foundation)).toThrow("foreign Compute resources");
  });

  it("uses paginated Cloud Asset Inventory to reject unclassified Compute resources", async () => {
    const assetUrls: URL[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "cloudasset.googleapis.com") {
        assetUrls.push(url);
        if (!url.searchParams.has("pageToken")) {
          return Response.json({
            results: [{
              name: "//compute.googleapis.com/projects/123/global/healthChecks/foreign-health",
              assetType: "compute.googleapis.com/HealthCheck",
              displayName: "foreign-health",
              location: "global",
            }],
            nextPageToken: "next",
          });
        }
        return Response.json({ results: [{
          name: "//compute.googleapis.com/projects/123/regions/europe-west3/routers/foreign-router",
          assetType: "compute.googleapis.com/Router",
          displayName: "foreign-router",
          location: "europe-west3",
        }] });
      }
      if (url.pathname.includes("/aggregated/")) return Response.json({ items: {} });
      return Response.json({ items: [] });
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    const inventory = await client.inventory();
    expect(assetUrls).toHaveLength(2);
    expect(assetUrls[0]!.searchParams.get("assetTypes")).toBe("compute.googleapis.com/.*");
    expect(inventory.computeAssets.map((asset) => asset.assetType)).toEqual([
      "compute.googleapis.com/HealthCheck",
      "compute.googleapis.com/Router",
    ]);
    expect(() => client.assertDedicatedProject(inventory))
      .toThrow("foreign Compute resources");
  });

  it("reconciles an ambiguous insert by deterministic name before retrying", async () => {
    const requests: Request[] = [];
    let postCount = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST") {
        postCount += 1;
        throw new Error("response lost after insert");
      }
      if (url.pathname.endsWith("/instances/intar-learner-abc")) {
        return Response.json({
          id: "8001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
          status: "RUNNING",
          disks: [{
            boot: true,
            source: "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/zones/europe-west3-a/disks/intar-learner-abc",
          }],
          networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "192.0.2.8" }] }],
        });
      }
      if (url.pathname.endsWith("/disks/intar-learner-abc")) {
        return Response.json({
          id: "9001",
          name: "intar-learner-abc",
          selfLink: `${url.origin}${url.pathname}`,
          labels: ownershipLabels(ownership),
          status: "READY",
        });
      }
      throw new Error(`Unhandled ${request.method} ${url.pathname}`);
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    const result = await client.advanceInstance(instanceInput());
    expect(result).toMatchObject({
      outcome: "reconciled",
      observation: { status: "present", publicIpv4: "192.0.2.8" },
    });
    expect(postCount).toBe(1);
    expect(requests.filter((request) => request.method === "GET").length).toBe(2);
  });

  it("retries a missing ambiguous insert with the identical idempotency key", async () => {
    const postRequestIds: string[] = [];
    let postCount = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST") {
        postCount += 1;
        postRequestIds.push(url.searchParams.get("requestId") ?? "");
        if (postCount === 1) throw new Error("ambiguous insert");
        return Response.json({
          id: "7001",
          name: "operation-7001",
          selfLink: "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/zones/europe-west3-a/operations/operation-7001",
          status: "PENDING",
        });
      }
      return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });
    await expect(client.advanceInstance(instanceInput())).resolves.toMatchObject({ outcome: "created" });
    expect(postRequestIds).toHaveLength(2);
    expect(postRequestIds[0]).toBe(postRequestIds[1]);
  });
});
