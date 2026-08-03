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
  it("labels provider connection sentinels as a distinct ownership purpose", () => {
    const sentinel = {
      organizationRef: "org-ref",
      connectionRef: "connection-ref",
      purpose: "provider_connection_sentinel",
    } as const;
    expect(ownershipToLabels(sentinel)).toEqual({
      intar_managed: "true",
      intar_provider: "hetzner_cloud",
      intar_org: "org-ref",
      intar_connection: "connection-ref",
      intar_purpose: "provider_connection_sentinel",
    });
    expect(labelsMatchOwnership(ownershipToLabels(sentinel), sentinel)).toBe(
      true,
    );
    expect(
      labelsMatchOwnership(
        ownershipToLabels({
          organizationRef: sentinel.organizationRef,
          connectionRef: sentinel.connectionRef,
          purpose: "learner_workspace",
        }),
        sentinel,
      ),
    ).toBe(false);
    expect(
      labelsMatchOwnership(
        { ...ownershipToLabels(sentinel), intar_workspace: "workspace-ref" },
        sentinel,
      ),
    ).toBe(false);
  });

  it("rejects scoped references on provider connection sentinels", () => {
    expect(() =>
      ownershipToLabels({
        organizationRef: "org-ref",
        connectionRef: "connection-ref",
        purpose: "provider_connection_sentinel",
        workspaceRef: "workspace-ref",
      } as never),
    ).toThrow("Provider sentinel ownership cannot include scoped references");
    expect(() =>
      ownershipToLabels({
        connectionRef: "connection-ref",
        purpose: "provider_connection_sentinel",
      } as never),
    ).toThrow("Invalid organization ownership reference");
  });

  it("rejects a sentinel request with no explicit ownership purpose", async () => {
    let fetchCalls = 0;
    const client = new HcloudClient("b".repeat(64), {
      fetcher: mockFetch(() => {
        fetchCalls += 1;
        return json({ firewalls: [], meta: {} });
      }),
    });

    await expect(
      client.ensureSentinel({
        name: "intar-fw-org1",
        ownership: {
          organizationRef: "org-ref",
          connectionRef: "connection-ref",
        } as never,
        stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      }),
    ).rejects.toThrow("Invalid provider sentinel ownership purpose");
    expect(fetchCalls).toBe(0);
  });

  it("pins learner ownership to its physical location attempt", () => {
    expect(
      ownershipToLabels({
        organizationRef: "org-ref",
        connectionRef: "connection-ref",
        purpose: "learner_workspace",
        workspaceRef: "workspace-ref",
        generation: 1,
        attempt: 2,
      }),
    ).toMatchObject({
      intar_workspace: "workspace-ref",
      intar_generation: "1",
      intar_attempt: "2",
    });
  });

  it("labels publication verifier resources without faking a learner workspace", () => {
    const verifier = {
      organizationRef: "org-ref",
      connectionRef: "connection-ref",
      purpose: "workshop_publication_verifier",
      workshopPublicationRef: "publication-ref",
      checkpointRef: "checkpoint-00",
      attempt: 1,
    } as const;
    expect(ownershipToLabels(verifier)).toEqual({
      intar_managed: "true",
      intar_provider: "hetzner_cloud",
      intar_org: "org-ref",
      intar_connection: "connection-ref",
      intar_purpose: "workshop_publication_verifier",
      intar_publication: "publication-ref",
      intar_checkpoint: "checkpoint-00",
      intar_attempt: "1",
    });
    expect(labelsMatchOwnership(ownershipToLabels(verifier), verifier)).toBe(
      true,
    );
  });

  it("rejects incomplete or learner-shaped publication verifier ownership", () => {
    expect(() =>
      ownershipToLabels({
        organizationRef: "org-ref",
        connectionRef: "connection-ref",
        purpose: "workshop_publication_verifier",
        workshopPublicationRef: "publication-ref",
        checkpointRef: "checkpoint-00",
        attempt: 0,
      }),
    ).toThrow("Invalid publication attempt ownership reference");
    expect(() =>
      ownershipToLabels({
        organizationRef: "org-ref",
        connectionRef: "connection-ref",
        workspaceRef: "workspace-ref",
        purpose: "workshop_publication_verifier",
        workshopPublicationRef: "publication-ref",
        checkpointRef: "checkpoint-00",
        attempt: 1,
      } as never),
    ).toThrow("Workshop publication ownership cannot include learner references");
  });

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
    let attempts = 0;
    const transportEvents: unknown[] = [];
    const client = new HcloudClient(token, {
      fetcher: mockFetch(() => {
        attempts += 1;
        throw new Error(`socket closed after create for ${token}`);
      }),
      onTransportFailure: (event) => transportEvents.push(event),
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
    expect(attempts).toBe(1);
    expect(transportEvents).toEqual([
      expect.objectContaining({
        event: "hcloud_transport_failure",
        method: "POST",
        endpoint: "/primary_ips",
        attempt: 1,
        failureKind: "transport",
      }),
    ]);
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(JSON.stringify(transportEvents)).not.toContain(token);
  });

  it("retries one idempotent GET with a sanitized transport event", async () => {
    const token = "read-retry-secret-".repeat(4);
    const retryDelays: number[] = [];
    const transportEvents: unknown[] = [];
    let attempts = 0;
    const client = new HcloudClient(token, {
      fetcher: mockFetch(() => {
        attempts += 1;
        if (attempts === 1) throw new Error(`temporary failure for ${token}`);
        return json({
          action: {
            id: 1,
            status: "success",
            command: "create_server",
            progress: 100,
            started: "2026-07-22T12:00:00Z",
            finished: "2026-07-22T12:00:01Z",
            error: null,
            resources: [],
          },
        });
      }),
      delay: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
      onTransportFailure: (event) => transportEvents.push(event),
    });

    await expect(client.getAction(9_001)).resolves.toMatchObject({
      id: 1,
      status: "success",
    });
    expect(attempts).toBe(2);
    expect(retryDelays).toHaveLength(1);
    expect(retryDelays[0]).toBeGreaterThanOrEqual(100);
    expect(retryDelays[0]).toBeLessThan(200);
    expect(transportEvents).toEqual([
      expect.objectContaining({
        event: "hcloud_transport_failure",
        method: "GET",
        endpoint: "/actions/:id",
        attempt: 1,
        failureKind: "transport",
      }),
    ]);
    expect(JSON.stringify(transportEvents)).not.toContain(token);
  });

  it("calls the fetcher without using the client as its receiver", async () => {
    const fetcher = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/actions/9001");
      return Promise.resolve(
        json({
          action: {
            id: 9_001,
            status: "success",
            command: "create_server",
            progress: 100,
            started: "2026-07-22T12:00:00Z",
            finished: "2026-07-22T12:00:01Z",
            error: null,
            resources: [],
          },
        }),
      );
    } as typeof fetch;
    const client = new HcloudClient("receiver-safe-token-".repeat(4), {
      fetcher,
    });

    await expect(client.getAction(9_001)).resolves.toMatchObject({
      id: 9_001,
      status: "success",
    });
  });

  it("bounds project inventory reads to four concurrent requests", async () => {
    const listKeys = new Map([
      ["/v1/servers", "servers"],
      ["/v1/primary_ips", "primary_ips"],
      ["/v1/floating_ips", "floating_ips"],
      ["/v1/firewalls", "firewalls"],
      ["/v1/networks", "networks"],
      ["/v1/volumes", "volumes"],
      ["/v1/placement_groups", "placement_groups"],
      ["/v1/images", "images"],
      ["/v1/ssh_keys", "ssh_keys"],
      ["/v1/load_balancers", "load_balancers"],
      ["/v1/certificates", "certificates"],
    ]);
    let requests = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const client = new HcloudClient("inventory-token-".repeat(4), {
      fetcher: mockFetch(async (request) => {
        const key = listKeys.get(new URL(request.url).pathname);
        if (!key) throw new Error("unexpected inventory endpoint");
        requests += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return json({ [key]: [], meta: { pagination: { next_page: null } } });
      }),
    });

    await expect(client.inventory()).resolves.toEqual(emptyInventory());
    expect(requests).toBe(11);
    expect(maxInFlight).toBe(4);
  });

  it("keeps at most four response bodies outstanding after fetch resolves", async () => {
    const listKeys = new Map([
      ["/v1/servers", "servers"],
      ["/v1/primary_ips", "primary_ips"],
      ["/v1/floating_ips", "floating_ips"],
      ["/v1/firewalls", "firewalls"],
      ["/v1/networks", "networks"],
      ["/v1/volumes", "volumes"],
      ["/v1/placement_groups", "placement_groups"],
      ["/v1/images", "images"],
      ["/v1/ssh_keys", "ssh_keys"],
      ["/v1/load_balancers", "load_balancers"],
      ["/v1/certificates", "certificates"],
    ]);
    let outstandingBodies = 0;
    let maxOutstandingBodies = 0;
    const client = new HcloudClient("body-limit-token-".repeat(4), {
      fetcher: mockFetch((request) => {
        const key = listKeys.get(new URL(request.url).pathname);
        if (!key) throw new Error("unexpected inventory endpoint");
        const payload = { [key]: [], meta: { pagination: { next_page: null } } };
        const response = json(payload);
        Object.defineProperty(response, "json", {
          configurable: true,
          value: async () => {
            outstandingBodies += 1;
            maxOutstandingBodies = Math.max(maxOutstandingBodies, outstandingBodies);
            await new Promise((resolve) => setTimeout(resolve, 5));
            outstandingBodies -= 1;
            return payload;
          },
        });
        return response;
      }),
    });

    await expect(client.inventory()).resolves.toEqual(emptyInventory());
    expect(outstandingBodies).toBe(0);
    expect(maxOutstandingBodies).toBe(4);
  });

  it("bounds concurrent reconciliation reads across the whole client", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = new HcloudClient("reconcile-token-".repeat(4), {
      fetcher: mockFetch(async (request) => {
        const actionId = Number(new URL(request.url).pathname.split("/").at(-1));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return json({
          action: {
            id: actionId,
            status: "success",
            command: "create_server",
            progress: 100,
            started: "2026-07-22T12:00:00Z",
            finished: "2026-07-22T12:00:01Z",
            error: null,
            resources: [],
          },
        });
      }),
    });

    await expect(
      Promise.all(Array.from({ length: 10 }, (_, index) => client.getAction(index + 1))),
    ).resolves.toHaveLength(10);
    expect(maxInFlight).toBe(4);
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
    let createBody:
      | { labels: Record<string, string>; rules: unknown[] }
      | undefined;
    const sentinelOwnership = {
      organizationRef: ownership.organizationRef,
      connectionRef: ownership.connectionRef,
      purpose: "provider_connection_sentinel",
    } as const;
    const firewall: HcloudFirewall = {
      id: 7001,
      name: "intar-fw-org1",
      labels: ownershipToLabels(sentinelOwnership),
      rules: sentinelRules(["198.51.100.7/32"]),
    };
    const client = new HcloudClient("b".repeat(64), {
      fetcher: mockFetch(async (request) => {
        if (request.method === "GET") return json({ firewalls: [], meta: {} });
        createBody = (await request.json()) as {
          labels: Record<string, string>;
          rules: unknown[];
        };
        return json({ firewall, actions: [] });
      }),
    });
    const result = await client.ensureSentinel({
      name: firewall.name,
      ownership: sentinelOwnership,
      stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
    });

    expect(result.created).toBe(true);
    expect(createBody?.labels).toEqual(ownershipToLabels(sentinelOwnership));
    expect(createBody?.rules).toEqual(sentinelRules(["198.51.100.7/32"]));
    expect(JSON.stringify(createBody?.rules)).not.toContain("direction\":\"out");
  });

  it("rejects a created firewall that drops the sentinel ownership purpose", async () => {
    const sentinelOwnership = {
      organizationRef: ownership.organizationRef,
      connectionRef: ownership.connectionRef,
      purpose: "provider_connection_sentinel",
    } as const;
    const client = new HcloudClient("b".repeat(64), {
      fetcher: mockFetch((request) => {
        if (request.method === "GET") return json({ firewalls: [], meta: {} });
        return json({
          firewall: {
            id: 7001,
            name: "intar-fw-org1",
            labels: ownershipToLabels({
              organizationRef: sentinelOwnership.organizationRef,
              connectionRef: sentinelOwnership.connectionRef,
              purpose: "learner_workspace",
            }),
            rules: sentinelRules(["198.51.100.7/32"]),
          },
          actions: [],
        });
      }),
    });

    await expect(
      client.ensureSentinel({
        name: "intar-fw-org1",
        ownership: sentinelOwnership,
        stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
      }),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_invalid_response", retryable: true },
    });
  });

  it("proves write access even when an existing sentinel already has the desired rules", async () => {
    const sentinelOwnership = {
      organizationRef: ownership.organizationRef,
      connectionRef: ownership.connectionRef,
      purpose: "provider_connection_sentinel",
    } as const;
    const firewall: HcloudFirewall = {
      id: 7001,
      name: "intar-fw-org1",
      labels: ownershipToLabels(sentinelOwnership),
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
      ownership: sentinelOwnership,
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

  it("keeps a valid exact type when every permitted location is temporarily exhausted", async () => {
    const exhaustedType = {
      ...serverFixture().server_type,
      locations: [
        {
          id: location.id,
          name: location.name,
          available: false,
          recommended: false,
          deprecation: null,
        },
      ],
    };
    const client = new HcloudClient("x".repeat(64), {
      fetcher: mockFetch((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/server_types") {
          return json({ server_types: [exhaustedType], meta: {} });
        }
        if (url.pathname === "/v1/locations") {
          return json({ locations: [location], meta: {} });
        }
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
              server_types: [
                {
                  id: exhaustedType.id,
                  name: exhaustedType.name,
                  prices: [
                    {
                      location: location.name,
                      price_hourly: { net: "0.0200", gross: "0.0238" },
                      price_monthly: { net: "12.0000", gross: "14.2800" },
                    },
                  ],
                },
              ],
              primary_ips: [
                {
                  type: "ipv4",
                  prices: [
                    {
                      location: location.name,
                      price_hourly: { net: "0.0010", gross: "0.00119" },
                      price_monthly: { net: "0.5000", gross: "0.5950" },
                    },
                  ],
                },
              ],
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
    ).resolves.toMatchObject({
      serverTypes: [
        {
          name: "cx43",
          locations: [{ name: "nbg1", available: false }],
        },
      ],
    });
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
      purpose: "provider_connection_sentinel",
    } as const;
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
        {
          ...emptyInventory(),
          firewalls: [
            {
              ...allowed,
              labels: ownershipToLabels({
                organizationRef: sentinelOwnership.organizationRef,
                connectionRef: sentinelOwnership.connectionRef,
                purpose: "learner_workspace",
              }),
            },
          ],
        },
        { name: allowed.name, ownership: sentinelOwnership },
      ),
    ).toThrow("empty except for its Intar firewall sentinel");
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
