import { describe, expect, it } from "vitest";
import type {
  HcloudFirewall,
  HcloudLocation,
  HcloudPrimaryIp,
  HcloudServer,
  HcloudSshKey,
  ProjectInventory,
} from "../src/contracts";
import {
  HcloudApiError,
  HcloudClient,
  labelsMatchOwnership,
  ownershipToLabels,
  sentinelRules,
} from "../src/hcloud-client";

const location: HcloudLocation = {
  id: 1,
  name: "nbg1",
  description: "Nuremberg",
  country: "DE",
  city: "Nuremberg",
  latitude: 49.4,
  longitude: 11.1,
  network_zone: "eu-central",
};

const ownership = {
  organizationRef: "org_0123456789",
  connectionRef: "conn_0123456789",
  workspaceRef: "ws_0123456789",
  generation: 1,
} as const;

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function mockFetch(
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return Promise.resolve(handler(request));
  }) as typeof fetch;
}

function emptyInventory(): ProjectInventory {
  return {
    servers: [],
    primaryIps: [],
    floatingIps: [],
    firewalls: [],
    networks: [],
    volumes: [],
    placementGroups: [],
    snapshots: [],
    sshKeys: [],
    loadBalancers: [],
    certificates: [],
  };
}

function serverFixture(): HcloudServer {
  return {
    id: 9001,
    created: "2026-07-22T11:59:59.500Z",
    name: "intar-vm-abc",
    status: "initializing",
    labels: ownershipToLabels(ownership),
    server_type: {
      id: 43,
      name: "cx43",
      description: "CX43",
      category: "shared",
      cores: 8,
      memory: 16,
      disk: 160,
      storage_type: "local",
      cpu_type: "shared",
      architecture: "x86",
    },
    location,
    primary_disk_size: 160,
    public_net: {
      ipv4: { id: 8001, ip: "192.0.2.10", blocked: false },
      ipv6: { id: 0, ip: "", blocked: false },
      floating_ips: [],
      firewalls: [{ id: 7001, status: "applied" }],
    },
  };
}

describe("HcloudClient", () => {
  it("never exposes the API token or provider body in an error", async () => {
    const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let authorization = "";
    const client = new HcloudClient(token, {
      fetcher: mockFetch((request) => {
        authorization = request.headers.get("authorization") ?? "";
        return json(
          { error: { code: token, message: `bad Bearer ${token}` } },
          { status: 401, headers: { "x-request-id": "provider-request-1" } },
        );
      }),
    });

    let caught: unknown;
    try {
      await client.getAction(1);
    } catch (error) {
      caught = error;
    }
    expect(authorization).toBe(`Bearer ${token}`);
    expect(caught).toBeInstanceOf(HcloudApiError);
    expect((caught as HcloudApiError).shape.code).toBe("hcloud_api_error");
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(String(caught)).not.toContain(token);
  });

  it("classifies ambiguous transport failures as retryable without leaking details", async () => {
    const token = "transport-secret-".repeat(4);
    const client = new HcloudClient(token, {
      fetcher: mockFetch(() => {
        throw new Error(`socket closed after create for ${token}`);
      }),
    });

    let caught: unknown;
    try {
      await client.createPrimaryIp({
        name: "intar-ip-transport",
        location: "nbg1",
        ownership,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      shape: {
        code: "hcloud_transport_error",
        retryable: true,
      },
    });
    expect(JSON.stringify(caught)).not.toContain(token);
  });

  it("rejects malformed provider creation timestamps", async () => {
    const client = new HcloudClient("t".repeat(64), {
      fetcher: mockFetch(() =>
        json({
          primary_ip: {
            id: 8001,
            created: "not-a-provider-timestamp",
            ip: "192.0.2.10",
            labels: ownershipToLabels(ownership),
            name: "intar-ip-invalid-time",
            type: "ipv4",
            assignee_id: null,
            assignee_type: "server",
            auto_delete: true,
            blocked: false,
            location,
          },
          action: null,
        }),
      ),
    });

    await expect(
      client.createPrimaryIp({
        name: "intar-ip-invalid-time",
        location: "nbg1",
        ownership,
      }),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_invalid_response", retryable: true },
    });
  });

  it("rejects a created resource whose ownership labels do not match", async () => {
    const client = new HcloudClient("u".repeat(64), {
      fetcher: mockFetch(() =>
        json({
          primary_ip: {
            id: 8001,
            created: "2026-07-22T12:00:00Z",
            ip: "192.0.2.10",
            labels: ownershipToLabels({
              ...ownership,
              workspaceRef: "ws_other",
            }),
            name: "intar-ip-wrong-owner",
            type: "ipv4",
            assignee_id: null,
            assignee_type: "server",
            auto_delete: true,
            blocked: false,
            location,
          },
          action: null,
        }),
      ),
    });

    await expect(
      client.createPrimaryIp({
        name: "intar-ip-wrong-owner",
        location: "nbg1",
        ownership,
      }),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_invalid_response", retryable: true },
    });
  });

  it("creates an IPv4-only server and drops provider root passwords", async () => {
    let body: Record<string, unknown> | undefined;
    const server = serverFixture();
    const client = new HcloudClient("a".repeat(64), {
      fetcher: mockFetch(async (request) => {
        body = (await request.json()) as Record<string, unknown>;
        return json({
          server,
          action: {
            id: 6001,
            status: "running",
            command: "create_server",
            progress: 0,
            started: "2026-07-22T12:00:00Z",
            finished: null,
            error: null,
            resources: [{ id: server.id, type: "server" }],
            provider_secret: "nested-must-never-escape",
          },
          next_actions: [],
          root_password: "must-never-escape",
        });
      }),
    });

    const result = await client.createServer({
      name: server.name,
      serverType: "cx43",
      systemImage: "debian-13",
      location: "nbg1",
      primaryIpv4Id: 8001,
      sshKeyId: 5001,
      firewallId: 7001,
      cloudInit: "#cloud-config\n",
      ownership,
    });

    expect(body?.public_net).toEqual({ enable_ipv4: true, enable_ipv6: false, ipv4: 8001 });
    expect(body?.ssh_keys).toEqual([5001]);
    expect(body?.firewalls).toEqual([{ firewall: 7001 }]);
    expect(body?.backups).toBe(false);
    expect(body).not.toHaveProperty("volumes");
    expect(result.resourceCreatedAt).toBe("2026-07-22T11:59:59.500Z");
    expect(JSON.stringify(result)).not.toContain("must-never-escape");
    expect(JSON.stringify(result)).not.toContain("nested-must-never-escape");
  });

  it("rejects malformed action payloads as retryable ambiguous responses", async () => {
    const server = serverFixture();
    const client = new HcloudClient("m".repeat(64), {
      fetcher: mockFetch(() =>
        json({
          server,
          action: {
            id: 6001,
            status: "running",
            command: "create_server",
            progress: 0,
            started: "2026-07-22T12:00:00Z",
            finished: null,
            error: null,
            resources: [{ id: server.id, type: "server" }],
          },
          next_actions: null,
        }),
      ),
    });

    await expect(
      client.createServer({
        name: server.name,
        serverType: "cx43",
        systemImage: "debian-13",
        location: "nbg1",
        primaryIpv4Id: 8001,
        sshKeyId: 5001,
        firewallId: 7001,
        cloudInit: "#cloud-config\n",
        ownership,
      }),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_invalid_response", retryable: true },
    });
  });

  it("accepts canonical OpenSSH public keys", async () => {
    const publicKey = `ssh-ed25519 ${"A".repeat(48)} intar-stargate`;
    const sshKey: HcloudSshKey = {
      id: 5001,
      name: "intar-workspace-key",
      fingerprint: "SHA256:test",
      public_key: publicKey,
      labels: ownershipToLabels(ownership),
    };
    const client = new HcloudClient("k".repeat(64), {
      fetcher: mockFetch(() => json({ ssh_key: sshKey })),
    });

    await expect(
      client.createSshKey({
        name: sshKey.name,
        publicKey,
        ownership,
      }),
    ).resolves.toEqual({ sshKey });
    await expect(
      client.createSshKey({
        name: sshKey.name,
        publicKey: `ssh-ed25519-extra ${"A".repeat(48)}`,
        ownership,
      }),
    ).rejects.toThrow("Invalid SSH public key");
  });

  it("creates or updates one persistent SSH-only firewall sentinel", async () => {
    let createBody: { rules: unknown[] } | undefined;
    const firewall: HcloudFirewall = {
      id: 7001,
      name: "intar-fw-org1",
      labels: ownershipToLabels({
        organizationRef: ownership.organizationRef,
        connectionRef: ownership.connectionRef,
      }),
      rules: sentinelRules(["198.51.100.7/32"]),
    };
    const client = new HcloudClient("b".repeat(64), {
      fetcher: mockFetch(async (request) => {
        if (request.method === "GET") return json({ firewalls: [], meta: {} });
        createBody = (await request.json()) as { rules: unknown[] };
        return json({ firewall, actions: [] });
      }),
    });
    const result = await client.ensureSentinel({
      name: firewall.name,
      ownership: {
        organizationRef: ownership.organizationRef,
        connectionRef: ownership.connectionRef,
      },
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
    });

    expect(result.created).toBe(true);
    expect(createBody?.rules).toEqual(sentinelRules(["198.51.100.7/32"]));
    expect(JSON.stringify(createBody?.rules)).not.toContain("direction\":\"out");
  });

  it("proves write access even when an existing sentinel already has the desired rules", async () => {
    const firewall: HcloudFirewall = {
      id: 7001,
      name: "intar-fw-org1",
      labels: ownershipToLabels({
        organizationRef: ownership.organizationRef,
        connectionRef: ownership.connectionRef,
      }),
      rules: sentinelRules(["198.51.100.7/32"]),
    };
    let setRulesCalls = 0;
    const client = new HcloudClient("w".repeat(64), {
      fetcher: mockFetch((request) => {
        if (request.method === "GET") return json({ firewalls: [firewall], meta: {} });
        setRulesCalls += 1;
        return json({ actions: [] });
      }),
    });

    const result = await client.ensureSentinel({
      name: firewall.name,
      ownership: {
        organizationRef: ownership.organizationRef,
        connectionRef: ownership.connectionRef,
      },
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
    });
    expect(result.created).toBe(false);
    expect(setRulesCalls).toBe(1);
  });

  it("rejects a server type with a top-level deprecation", async () => {
    const client = new HcloudClient("p".repeat(64), {
      fetcher: mockFetch((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/server_types") {
          return json({
            server_types: [
              {
                ...serverFixture().server_type,
                deprecation: {
                  announced: "2026-07-01T00:00:00Z",
                  unavailable_after: "2026-08-01T00:00:00Z",
                },
              },
            ],
            meta: {},
          });
        }
        if (url.pathname === "/v1/locations") return json({ locations: [location], meta: {} });
        if (url.pathname === "/v1/images") {
          return json({
            images: [
              {
                id: 13,
                status: "available",
                type: "system",
                name: "debian-13",
                description: "Debian 13",
                architecture: "x86",
                deprecated: null,
                deleted: null,
                os_flavor: "debian",
                os_version: "13",
              },
            ],
            meta: {},
          });
        }
        if (url.pathname === "/v1/pricing") {
          return json({
            pricing: { currency: "EUR", vat_rate: "0.19", server_types: [], primary_ips: [] },
          });
        }
        throw new Error(`Unhandled ${url.pathname}`);
      }),
    });

    await expect(
      client.observeCatalog({
        requiredServerTypes: ["cx43"],
        permittedLocations: ["nbg1"],
        systemImage: "debian-13",
      }),
    ).rejects.toThrow("Required Hetzner server type cx43 is unavailable");
  });

  it("requires exact server and IPv4 pricing in every permitted location", async () => {
    let ipv4Prices: Array<{
      location: string;
      price_hourly: { net: string; gross: string };
      price_monthly: { net: string; gross: string };
    }> = [];
    const client = new HcloudClient("q".repeat(64), {
      fetcher: mockFetch((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/server_types") {
          return json({
            server_types: [
              {
                ...serverFixture().server_type,
                locations: [
                  {
                    id: location.id,
                    name: location.name,
                    available: true,
                    recommended: true,
                    deprecation: null,
                  },
                ],
              },
            ],
            meta: {},
          });
        }
        if (url.pathname === "/v1/locations") return json({ locations: [location], meta: {} });
        if (url.pathname === "/v1/images") {
          return json({
            images: [
              {
                id: 13,
                status: "available",
                type: "system",
                name: "debian-13",
                description: "Debian 13",
                architecture: "x86",
                deprecated: null,
                deleted: null,
                os_flavor: "debian",
                os_version: "13",
              },
            ],
            meta: {},
          });
        }
        if (url.pathname === "/v1/pricing") {
          return json({
            pricing: {
              currency: "EUR",
              vat_rate: "0.19",
              server_types: [{ id: 43, name: "cx43", prices: [] }],
              primary_ips: [{ type: "ipv4", prices: ipv4Prices }],
            },
          });
        }
        throw new Error(`Unhandled ${url.pathname}`);
      }),
    });

    await expect(
      client.observeCatalog({
        requiredServerTypes: ["cx43"],
        permittedLocations: ["nbg1"],
        systemImage: "debian-13",
      }),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_pricing_unavailable", retryable: true },
    });
    await expect(
      client.observeCatalog({
        requiredServerTypes: [],
        permittedLocations: ["nbg1"],
        systemImage: "debian-13",
      }),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_pricing_unavailable", retryable: true },
    });
    ipv4Prices = [
      {
        location: "nbg1",
        price_hourly: { net: "0.0010", gross: "0.00119" },
        price_monthly: { net: "0.5000", gross: "0.5950" },
      },
    ];
    await expect(
      client.observeCatalog({
        requiredServerTypes: [],
        permittedLocations: ["nbg1"],
        systemImage: "debian-13",
      }),
    ).resolves.toMatchObject({ serverTypes: [], locations: [{ name: "nbg1" }] });
  });

  it("enforces an empty dedicated project while permitting only the owned sentinel", () => {
    const client = new HcloudClient("c".repeat(64));
    const sentinelOwnership = {
      organizationRef: ownership.organizationRef,
      connectionRef: ownership.connectionRef,
    };
    const allowed: HcloudFirewall = {
      id: 1,
      name: "intar-fw-org1",
      labels: ownershipToLabels(sentinelOwnership),
      rules: [],
    };
    const inventory = { ...emptyInventory(), firewalls: [allowed] };
    expect(() =>
      client.assertDedicatedProject(inventory, {
        name: allowed.name,
        ownership: sentinelOwnership,
      }),
    ).not.toThrow();
    expect(() =>
      client.assertDedicatedProject(
        { ...inventory, sshKeys: [{ id: 2, name: "foreign", fingerprint: "x", public_key: "x", labels: {} }] },
        { name: allowed.name, ownership: sentinelOwnership },
      ),
    ).toThrow("empty except for its Intar firewall sentinel");
    expect(() =>
      client.assertDedicatedProject(
        { ...inventory, certificates: [{ id: 3, name: "foreign-certificate" }] },
        { name: allowed.name, ownership: sentinelOwnership },
      ),
    ).toThrow("empty except for its Intar firewall sentinel");
  });

  it("reconciles ambiguous creates by deterministic name and ownership labels", async () => {
    const ownedIp: HcloudPrimaryIp = {
      id: 8001,
      created: "2026-07-22T11:58:00+00:00",
      ip: "192.0.2.10",
      labels: ownershipToLabels(ownership),
      name: "intar-ip-abc",
      type: "ipv4",
      assignee_id: null,
      assignee_type: "server",
      auto_delete: true,
      blocked: false,
      location,
    };
    const client = new HcloudClient("d".repeat(64), {
      fetcher: mockFetch((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/primary_ips/8001") {
          return json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
        }
        return json({ primary_ips: [ownedIp], meta: {} });
      }),
    });
    const observation = await client.reconcileResource({
      resourceKind: "primary_ip",
      externalId: 8001,
      deterministicName: ownedIp.name,
      ownership,
    });
    expect(observation).toMatchObject({
      status: "present",
      externalId: 8001,
      resourceCreatedAt: "2026-07-22T11:58:00+00:00",
      publicIpv4: "192.0.2.10",
    });
    expect(labelsMatchOwnership(ownedIp.labels, ownership)).toBe(true);
  });

  it("deletes the persistent firewall sentinel only as an explicit resource step", async () => {
    let observedPath = "";
    let observedMethod = "";
    const client = new HcloudClient("f".repeat(64), {
      fetcher: mockFetch((request) => {
        const url = new URL(request.url);
        observedPath = url.pathname;
        observedMethod = request.method;
        return new Response(null, { status: 204 });
      }),
    });
    await expect(client.deleteResource("firewall", 7001)).resolves.toEqual({
      action: null,
      alreadyMissing: false,
    });
    expect(observedMethod).toBe("DELETE");
    expect(observedPath).toBe("/v1/firewalls/7001");
  });
});
