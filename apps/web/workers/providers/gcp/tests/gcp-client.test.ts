import { describe, expect, it } from "vitest";
import type {
  GcpFoundationSpec,
  GcpProjectInventory,
  GcpServiceAccountKey,
} from "@intar/provider-contracts/gcp";
import {
  classifyOperationalInventory,
  GcpClient,
  labelsMatchOwnership,
  ownershipLabels,
  ownershipMarker,
} from "../src/gcp-client";

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
    cloudInit: "#cloud-config\npackages:\n  - jq\n",
    ownership,
    generation: 1,
  } as const;
}

function effectiveFirewalls(
  foundation: GcpFoundationSpec,
  policyRules: unknown[] = [],
) {
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
      rules: policyRules,
    }],
  };
}

function foundationRoutes(
  foundation: GcpFoundationSpec,
  additionalRoutes: unknown[] = [],
) {
  const network =
    `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
    `global/networks/${foundation.networkName}`;
  return {
    items: [{
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
    }, {
      id: "route-default-1",
      name: "default-route-internet",
      selfLink:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
        "global/routes/default-route-internet",
      network,
      routeType: "STATIC",
      destRange: "0.0.0.0/0",
      priority: 1_000,
      nextHopGateway:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
        "global/gateways/default-internet-gateway",
      tags: [],
    }, ...additionalRoutes],
  };
}

describe("GcpClient", () => {
  it("checks the exact pinned image instead of the mutable family head", async () => {
    const requests: string[] = [];
    const image = (name: string) => ({
      id: `id-${name}`,
      name,
      selfLink:
        `https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/${name}`,
      architecture: "X86_64",
      status: "READY",
      diskSizeGb: "10",
      creationTimestamp: "2026-08-01T00:00:00.000Z",
    });
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(new Request(input).url);
      requests.push(url.pathname);
      return Response.json(url.pathname.endsWith("/images/family/debian-13")
        ? image("debian-13-trixie-v20260815")
        : image("debian-13-trixie-v20260801"));
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({
        accessToken: "test-access-token",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });
    const pinned =
      "https://compute.googleapis.com/compute/v1/projects/debian-cloud/" +
      "global/images/debian-13-trixie-v20260801";

    await expect(client.resolveImageFamily(
      "projects/debian-cloud/global/images/family/debian-13",
    )).resolves.toMatchObject({ name: "debian-13-trixie-v20260815" });
    await expect(client.resolveImage(pinned)).resolves.toMatchObject({
      name: "debian-13-trixie-v20260801",
      selfLink: pinned,
    });
    expect(requests).toEqual([
      "/compute/v1/projects/debian-cloud/global/images/family/debian-13",
      "/compute/v1/projects/debian-cloud/global/images/debian-13-trixie-v20260801",
    ]);
  });

  it.each([
    ["missing", null, 404, "gcp_not_found"],
    ["deprecated", { deprecated: { state: "DEPRECATED" } }, 200, "gcp_image_unsupported"],
    ["not ready", { status: "PENDING" }, 200, "gcp_image_unsupported"],
  ] as const)("rejects a %s pinned image", async (_case, override, status, code) => {
    const name = "debian-13-trixie-v20260801";
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async () => status === 404
        ? Response.json({ error: { status: "NOT_FOUND" } }, { status })
        : Response.json({
            id: "image-1",
            name,
            selfLink:
              `https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/${name}`,
            architecture: "X86_64",
            status: "READY",
            diskSizeGb: "10",
            creationTimestamp: "2026-08-01T00:00:00.000Z",
            ...override,
          })) as typeof fetch,
      tokenProvider: async () => ({
        accessToken: "test-access-token",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.resolveImage(
      `https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/${name}`,
    )).rejects.toMatchObject({ shape: { code } });
  });

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
    const nextZone = await client.createInstance({ ...input, zone: "europe-west3-b" });
    expect(first.requestId).toBe(second.requestId);
    expect(nextZone.requestId).not.toBe(first.requestId);
    expect(first.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(new URL(requests[0]!.url).searchParams.get("requestId")).toBe(first.requestId);
    const body = await requests[0]!.clone().json<Record<string, unknown>>();
    expect(body).toHaveProperty("serviceAccounts", []);
    expect(body).not.toHaveProperty("networkInterfaces.0.ipv6AccessConfigs");
    expect(body).toMatchObject({
      canIpForward: false,
      tags: { items: ["intar-learner"] },
    });
    expect(body).not.toHaveProperty("deletionProtection");
    expect(body.disks).toHaveLength(1);
    expect(body.networkInterfaces).toHaveLength(1);
    expect(body).toMatchObject({
      networkInterfaces: [{
        stackType: "IPV4_ONLY",
        accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
      }],
      metadata: { items: expect.arrayContaining([
        { key: "block-project-ssh-keys", value: "TRUE" },
        { key: "user-data", value: input.cloudInit },
        { key: "startup-script", value: expect.stringContaining("#!/bin/bash") },
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
    expect(JSON.stringify(body)).not.toContain('"ssh-keys"');
    const startupScript = (body.metadata as { items: Array<{ key: string; value: string }> })
      .items.find((item) => item.key === "startup-script")?.value;
    expect(startupScript).toContain("datasource_list: [ NoCloud ]");
    expect(startupScript).toContain("/instance/attributes/user-data");
    expect(startupScript).toContain('touch "$marker"');
    expect(startupScript).toContain("systemctl reboot");
  });

  it("fails closed on non-cloud-config and oversized cloud-init data", async () => {
    const fetcher = (async () => {
      throw new Error("GCP must not be called");
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({
        accessToken: "unused",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.createInstance({
      ...instanceInput(),
      cloudInit: "#!/bin/bash\ntrue\n",
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
    await expect(client.createInstance({
      ...instanceInput(),
      cloudInit: `#cloud-config\n${"x".repeat(256 * 1024)}`,
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
  });

  it("rejects fractional disk sizes and generations before calling Compute", async () => {
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async () => {
        throw new Error("GCP must not be called");
      }) as typeof fetch,
      tokenProvider: async () => ({
        accessToken: "unused",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.createInstance({
      ...instanceInput(),
      rootDiskGib: 32.5,
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
    await expect(client.createInstance({
      ...instanceInput(),
      generation: 1.5,
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
  });

  it("rejects uncertified machine types and source images", async () => {
    const fetcher = (async () => {
      throw new Error("GCP must not be called");
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({
        accessToken: "unused",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.createInstance({
      ...instanceInput(),
      machineType: "e2-standard-8",
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
    await expect(client.createInstance({
      ...instanceInput(),
      sourceImage:
        "https://compute.googleapis.com/compute/v1/projects/ubuntu-os-cloud/" +
        "global/images/ubuntu-2404-noble-amd64-v20260801",
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
    await expect(client.createInstance({
      ...instanceInput(),
      sourceImage:
        "https://compute.googleapis.com/compute/v1/projects/debian-cloud/" +
        "global/images/debian-12-bookworm-v20260801",
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
    await expect(client.createInstance({
      ...instanceInput(),
      name: `intar-${"a".repeat(58)}`,
    })).rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
  });

  it("rejects ownership references instead of normalizing them into collisions", () => {
    expect(() => ownershipLabels({
      ...ownership,
      organizationRef: "ORG_0123456789",
    })).toThrow("ownership reference is invalid");
    expect(() => ownershipLabels({
      ...ownership,
      workshopPublicationRef: "publication_1",
    })).toThrow("learner ownership is invalid");
  });

  it("encodes long or trailing-hyphen checkpoint IDs as exact safe labels", () => {
    for (const checkpointRef of ["a".repeat(64), "checkpoint-"]) {
      const publicationOwnership = {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "workshop_publication_verifier",
        workshopPublicationRef: "publication-1",
        checkpointRef,
        attempt: 1,
      } as const;
      const first = ownershipLabels(publicationOwnership);
      const second = ownershipLabels(publicationOwnership);
      const encoded = first["intar-checkpoint"]!;

      expect(encoded).toBe(second["intar-checkpoint"]);
      expect(encoded).toHaveLength(63);
      expect(encoded).toMatch(/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])$/u);
      expect(encoded).not.toBe(checkpointRef);
      expect(labelsMatchOwnership(first, publicationOwnership)).toBe(true);
      const replacement = encoded.endsWith("0") ? "1" : "0";
      expect(labelsMatchOwnership({
        ...first,
        "intar-checkpoint": `${encoded.slice(0, -1)}${replacement}`,
      }, publicationOwnership)).toBe(false);
    }
    expect(() => ownershipLabels({
      organizationRef: "org_0123456789",
      connectionRef: "conn_0123456789",
      purpose: "workshop_publication_verifier",
      workshopPublicationRef: "publication-1",
      checkpointRef: "-checkpoint",
      attempt: 1,
    })).toThrow("publication ownership is invalid");
  });

  it("rejects an invalid provider resource creation timestamp", async () => {
    const selfLink =
      `https://compute.googleapis.com/compute/v1/projects/${key.project_id}` +
      "/global/networks/intar-network-main";
    const client = new GcpClient(key, key.project_id, {
      fetcher: (async () => Response.json({
        id: "network-1",
        name: "intar-network-main",
        selfLink,
        creationTimestamp: "not-a-timestamp",
      })) as typeof fetch,
      tokenProvider: async () => ({
        accessToken: "token",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.observeResource(selfLink))
      .rejects.toMatchObject({ shape: { code: "gcp_invalid_response" } });
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
      subnetworkCidr: "10.77.0.0/20",
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

  it("skips one exact inherent project asset and rejects mismatched or duplicate assets", () => {
    const foundation = {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.77.0.0/20",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      ownership: {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "provider_connection_sentinel",
      },
    } satisfies GcpFoundationSpec;
    const inherent = {
      fullResourceName: `//compute.googleapis.com/projects/${key.project_id}`,
      assetType: "compute.googleapis.com/Project",
      displayName: key.project_id,
      location: "global",
    };
    const classify = (computeAssets: GcpProjectInventory["computeAssets"]) =>
      classifyOperationalInventory(
        { ...emptyInventory(), computeAssets },
        foundation,
        ownership,
        key.project_id,
      );

    expect(classify([inherent])).toMatchObject({
      status: "empty",
      ownedComputeAssets: [],
      foreignComputeAssets: [],
    });
    expect(classify([{ ...inherent, fullResourceName:
      "//compute.googleapis.com/projects/other-project-12345" }])).toMatchObject({
      status: "foreign_resources_present",
      foreignComputeAssets: [expect.objectContaining({
        fullResourceName: "//compute.googleapis.com/projects/other-project-12345",
      })],
    });
    expect(classify([inherent, inherent])).toMatchObject({
      status: "foreign_resources_present",
      foreignComputeAssets: [inherent],
    });
  });

  it("accepts only the aligned Workshop /20 and Stargate /32 CIDRs", async () => {
    const foundation = {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.77.0.0/20",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["198.51.100.7/32", "203.0.113.9/32"],
      ownership: {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "provider_connection_sentinel",
      },
    } satisfies GcpFoundationSpec;
    const marker =
      "intar-managed=true;organization=org_0123456789;" +
      "connection=conn_0123456789;purpose=provider_connection_sentinel";
    const requests: Request[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const name = url.pathname.split("/").at(-1)!;
      const networkSelfLink =
        "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/" +
        "global/networks/intar-network-main";
      const base = {
        id: `${name}-1`,
        name,
        selfLink: `${url.origin}${url.pathname}`,
        description: marker,
      };
      if (url.pathname.endsWith("/getEffectiveFirewalls")) {
        return Response.json(effectiveFirewalls(foundation, [{
          action: "allow",
          direction: "INGRESS",
          disabled: false,
          targetType: "INSTANCES",
          targetResources: [networkSelfLink],
          targetServiceAccounts: [],
          targetSecureTags: [],
          match: {
            srcIpRanges: foundation.stargateEgressIpv4Cidrs,
            layer4Configs: [{ ipProtocol: "tcp", ports: ["22"] }],
          },
        }]));
      }
      if (url.pathname.endsWith("/global/routes")) {
        return Response.json(foundationRoutes(foundation));
      }
      if (url.pathname.includes("/global/networks/")) {
        return Response.json({
          ...base,
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: "REGIONAL" },
        });
      }
      if (url.pathname.includes("/subnetworks/")) {
        return Response.json({
          ...base,
          network: networkSelfLink,
          region:
            "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/" +
            "regions/europe-west3",
          ipCidrRange: "10.77.0.0/20",
          privateIpGoogleAccess: false,
          stackType: "IPV4_ONLY",
        });
      }
      return Response.json({
        ...base,
        network: networkSelfLink,
        direction: "INGRESS",
        priority: 1_000,
        sourceRanges: foundation.stargateEgressIpv4Cidrs,
        targetTags: ["intar-learner"],
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        disabled: false,
      });
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({ accessToken: "token", expiresAtEpochSeconds: 4_000_000_000 }),
    });

    await expect(client.ensureFoundation(foundation)).resolves.toMatchObject({
      network: { name: foundation.networkName },
      subnetwork: { name: foundation.subnetworkName },
      firewall: { name: foundation.firewallName },
      createdResourceSelfLinks: [],
    });
    expect(requests).toHaveLength(6);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const regionalEffective = requests.find((request) =>
      new URL(request.url).pathname.includes("/regions/europe-west3/firewallPolicies/")
    );
    expect(new URL(regionalEffective!.url).searchParams.get("network")).toBe(
      `projects/${key.project_id}/global/networks/${foundation.networkName}`,
    );

    for (const invalid of [
      { ...foundation, subnetworkCidr: "10.77.1.0/20" },
      { ...foundation, subnetworkCidr: "10.77.0.0/24" },
      { ...foundation, stargateEgressIpv4Cidrs: ["198.51.100.7/31"] },
      { ...foundation, stargateEgressIpv4Cidrs: ["198.051.100.7/32"] },
    ]) {
      await expect(client.ensureFoundation(invalid))
        .rejects.toMatchObject({ shape: { code: "invalid_provider_request" } });
    }
    expect(requests).toHaveLength(6);
  });

  it("rejects a deleted default route and a tagged higher-priority route", async () => {
    const foundation = {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.77.0.0/20",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      ownership: {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "provider_connection_sentinel",
      },
    } satisfies GcpFoundationSpec;
    const networkSelfLink =
      `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
      `global/networks/${foundation.networkName}`;
    const safeRoutes = foundationRoutes(foundation).items;
    let routeItems: unknown[] = [safeRoutes[0]];
    const requests: Request[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const name = url.pathname.split("/").at(-1)!;
      const base = {
        id: `${name}-1`,
        name,
        selfLink: `${url.origin}${url.pathname}`,
        description: ownershipMarker(foundation.ownership),
      };
      if (url.pathname.endsWith("/getEffectiveFirewalls")) {
        return Response.json(effectiveFirewalls(foundation));
      }
      if (url.pathname.endsWith("/global/routes")) {
        return Response.json({ items: routeItems });
      }
      if (url.pathname.includes("/global/networks/")) {
        return Response.json({
          ...base,
          name: foundation.networkName,
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: "REGIONAL" },
        });
      }
      if (url.pathname.includes("/subnetworks/")) {
        return Response.json({
          ...base,
          name: foundation.subnetworkName,
          network: networkSelfLink,
          region:
            `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
            "regions/europe-west3",
          ipCidrRange: foundation.subnetworkCidr,
          privateIpGoogleAccess: false,
          stackType: "IPV4_ONLY",
        });
      }
      return Response.json({
        ...base,
        name: foundation.firewallName,
        network: networkSelfLink,
        direction: "INGRESS",
        priority: 1_000,
        sourceRanges: foundation.stargateEgressIpv4Cidrs,
        sourceTags: [],
        sourceServiceAccounts: [],
        targetTags: ["intar-learner"],
        targetServiceAccounts: [],
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        denied: [],
        disabled: false,
      });
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({
        accessToken: "token",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.inspectFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });

    routeItems = [...safeRoutes, {
      id: "route-custom-1",
      name: "learner-custom-default",
      selfLink:
        `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
        "global/routes/learner-custom-default",
      network: networkSelfLink,
      routeType: "STATIC",
      destRange: "0.0.0.0/0",
      priority: 900,
      tags: ["intar-learner"],
      nextHopIp: "10.77.0.2",
    }];
    await expect(client.ensureFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });

    expect(requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/global/routes")
    )).toHaveLength(2);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("rejects effective rules that expose or isolate the learner", async () => {
    const foundation = {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.77.0.0/20",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      ownership: {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "provider_connection_sentinel",
      },
    } satisfies GcpFoundationSpec;
    const networkSelfLink =
      `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
      `global/networks/${foundation.networkName}`;
    const requests: Request[] = [];
    let effectivePayload: unknown = effectiveFirewalls(foundation, [{
      action: "allow",
      direction: "INGRESS",
      disabled: false,
      targetType: "INSTANCES",
      targetResources: [networkSelfLink],
      match: {
        srcIpRanges: ["0.0.0.0/0"],
        layer4Configs: [{ ipProtocol: "tcp", ports: ["22"] }],
      },
    }]);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/getEffectiveFirewalls")) {
        return Response.json(effectivePayload);
      }
      const base = {
        id: `${url.pathname.split("/").at(-1)}-1`,
        name: url.pathname.split("/").at(-1),
        selfLink: `${url.origin}${url.pathname}`,
        description: ownershipMarker(foundation.ownership),
      };
      if (url.pathname.includes("/global/networks/")) {
        return Response.json({
          ...base,
          name: foundation.networkName,
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: "REGIONAL" },
        });
      }
      if (url.pathname.includes("/subnetworks/")) {
        return Response.json({
          ...base,
          name: foundation.subnetworkName,
          network: networkSelfLink,
          region:
            `https://compute.googleapis.com/compute/v1/projects/${key.project_id}/` +
            "regions/europe-west3",
          ipCidrRange: foundation.subnetworkCidr,
          privateIpGoogleAccess: false,
          stackType: "IPV4_ONLY",
        });
      }
      return Response.json({
        ...base,
        name: foundation.firewallName,
        network: networkSelfLink,
        direction: "INGRESS",
        priority: 1_000,
        sourceRanges: foundation.stargateEgressIpv4Cidrs,
        sourceTags: [],
        sourceServiceAccounts: [],
        targetTags: ["intar-learner"],
        targetServiceAccounts: [],
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        denied: [],
        disabled: false,
      });
    }) as typeof fetch;
    const client = new GcpClient(key, key.project_id, {
      fetcher,
      tokenProvider: async () => ({
        accessToken: "token",
        expiresAtEpochSeconds: 4_000_000_000,
      }),
    });

    await expect(client.inspectFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });

    const classicIngress = effectiveFirewalls(foundation);
    effectivePayload = {
      ...classicIngress,
      firewalls: [
        ...classicIngress.firewalls,
        {
          name: "deny-stargate-ingress",
          direction: "INGRESS",
          disabled: false,
          sourceRanges: ["0.0.0.0/0"],
          targetTags: ["intar-learner"],
          targetServiceAccounts: [],
          denied: [{ IPProtocol: "all" }],
        },
      ],
    };
    await expect(client.inspectFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });

    effectivePayload = effectiveFirewalls(foundation, [{
      action: "deny",
      direction: "INGRESS",
      disabled: false,
      targetType: "INSTANCES",
      targetResources: [networkSelfLink],
      match: {
        srcIpRanges: ["0.0.0.0/0"],
        layer4Configs: [{ ipProtocol: "all" }],
      },
    }]);
    await expect(client.inspectFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });

    const classicEgress = effectiveFirewalls(foundation);
    effectivePayload = {
      ...classicEgress,
      firewalls: [
        ...classicEgress.firewalls,
        {
          name: "deny-learner-egress",
          direction: "EGRESS",
          disabled: false,
          destinationRanges: ["0.0.0.0/0"],
          targetTags: ["intar-learner"],
          targetServiceAccounts: [],
          denied: [{ IPProtocol: "all" }],
        },
      ],
    };
    await expect(client.inspectFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });

    effectivePayload = effectiveFirewalls(foundation, [{
      action: "deny",
      direction: "EGRESS",
      disabled: false,
      targetType: "INSTANCES",
      targetResources: [networkSelfLink],
      match: {
        destIpRanges: ["0.0.0.0/0"],
        layer4Configs: [{ ipProtocol: "all" }],
      },
    }]);
    await expect(client.inspectFoundation(foundation))
      .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });
    expect(requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/getEffectiveFirewalls")
    )).toHaveLength(10);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("rejects existing foundation drift without changing the resources", async () => {
    const foundation = {
      networkName: "intar-network-main",
      subnetworkName: "intar-subnet-main",
      subnetworkRegion: "europe-west3",
      subnetworkCidr: "10.77.0.0/20",
      firewallName: "intar-firewall-main",
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      ownership: {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "provider_connection_sentinel",
      },
    } satisfies GcpFoundationSpec;
    const marker =
      "intar-managed=true;organization=org_0123456789;" +
      "connection=conn_0123456789;purpose=provider_connection_sentinel";
    const networkSelfLink =
      "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/" +
      "global/networks/intar-network-main";

    for (const drift of [
      "network",
      "subnetwork",
      "firewall",
      "firewall-selectors",
    ] as const) {
      const requests: Request[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        const name = url.pathname.split("/").at(-1)!;
        const base = {
          id: `${name}-1`,
          name,
          selfLink: `${url.origin}${url.pathname}`,
          description: marker,
        };
        if (url.pathname.includes("/global/networks/")) {
          return Response.json({
            ...base,
            autoCreateSubnetworks: drift === "network",
            routingConfig: { routingMode: "REGIONAL" },
          });
        }
        if (url.pathname.includes("/subnetworks/")) {
          return Response.json({
            ...base,
            network: networkSelfLink,
            region:
              "https://compute.googleapis.com/compute/v1/projects/intar-empty-12345/" +
              "regions/europe-west3",
            ipCidrRange: drift === "subnetwork" ? "10.88.0.0/20" : "10.77.0.0/20",
            privateIpGoogleAccess: false,
            stackType: "IPV4_ONLY",
          });
        }
        return Response.json({
          ...base,
          network: networkSelfLink,
          direction: "INGRESS",
          priority: 1_000,
          sourceRanges: drift === "firewall"
            ? ["0.0.0.0/0"]
            : foundation.stargateEgressIpv4Cidrs,
          sourceTags: drift === "firewall-selectors" ? ["unexpected-source"] : [],
          targetTags: ["intar-learner"],
          allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
          disabled: false,
        });
      }) as typeof fetch;
      const client = new GcpClient(key, key.project_id, {
        fetcher,
        tokenProvider: async () => ({
          accessToken: "token",
          expiresAtEpochSeconds: 4_000_000_000,
        }),
      });

      await expect(client.ensureFoundation(foundation))
        .rejects.toMatchObject({ shape: { code: "gcp_foundation_drift" } });
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }
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
