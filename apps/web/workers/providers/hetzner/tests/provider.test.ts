import { describe, expect, it } from "vitest";
import type {
  ConnectProjectRequest,
  CredentialContext,
  HcloudFirewall,
  HcloudLocation,
} from "../src/contracts";
import { ownershipToLabels } from "../src/hcloud-client";
import { connectProject, rotateCredential, runOperation } from "../src/provider";

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

function kekSecret(): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(9)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function mockFetch(
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new Request(input, init)))) as typeof fetch;
}

const context: CredentialContext = {
  organizationId: "org_0123456789",
  connectionId: "conn_0123456789",
  credentialId: "cred_0123456789",
  provider: "hetzner_cloud",
  version: 1,
};

const connectRequest: ConnectProjectRequest = {
  requestId: "request-connect-0001",
  connectionId: context.connectionId,
  credentialContext: context,
  token: "e".repeat(64),
  sentinel: {
    name: "intar-fw-org1",
    ownership: {
      organizationRef: "org_0123456789",
      connectionRef: "conn_0123456789",
      purpose: "provider_connection_sentinel",
    },
    stargateEgressIpv4Cidrs: ["198.51.100.7/32"],
  },
  requiredServerTypes: [],
  permittedLocations: ["nbg1"],
  systemImage: "debian-13",
};

function listKeyFor(pathname: string): string | undefined {
  return {
    "/v1/servers": "servers",
    "/v1/primary_ips": "primary_ips",
    "/v1/floating_ips": "floating_ips",
    "/v1/firewalls": "firewalls",
    "/v1/networks": "networks",
    "/v1/volumes": "volumes",
    "/v1/placement_groups": "placement_groups",
    "/v1/ssh_keys": "ssh_keys",
    "/v1/load_balancers": "load_balancers",
    "/v1/certificates": "certificates",
  }[pathname];
}

describe("provider operation boundary", () => {
  it("validates the project, proves write access, then seals the token", async () => {
    let createdFirewallBody: unknown;
    const sentinel: HcloudFirewall = {
      id: 7001,
      name: connectRequest.sentinel.name,
      labels: ownershipToLabels(connectRequest.sentinel.ownership),
      rules: [],
    };
    const fetcher = mockFetch(async (request) => {
      const url = new URL(request.url);
      const key = listKeyFor(url.pathname);
      if (key) {
        if (url.pathname === "/v1/firewalls" && request.method === "POST") {
          createdFirewallBody = await request.json();
          return json({ firewall: sentinel, actions: [] });
        }
        return json({ [key]: [], meta: {} });
      }
      if (url.pathname === "/v1/images") {
        if (url.searchParams.get("type") === "snapshot") return json({ images: [], meta: {} });
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
      if (url.pathname === "/v1/server_types") {
        return json({
          server_types: [
            {
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
              deprecated: false,
              locations: [{ id: 1, name: "nbg1", available: true, recommended: true }],
            },
          ],
          meta: {},
        });
      }
      if (url.pathname === "/v1/locations") return json({ locations: [location], meta: {} });
      if (url.pathname === "/v1/pricing") {
        return json({
          pricing: {
            currency: "EUR",
            vat_rate: "0.19",
            server_types: [
              {
                id: 43,
                name: "cx43",
                prices: [
                  {
                    location: "nbg1",
                    price_hourly: { net: "0.0100", gross: "0.0119" },
                    price_monthly: { net: "6.0000", gross: "7.1400" },
                    included_traffic: 0,
                    price_per_tb_traffic: { net: "1.0000", gross: "1.1900" },
                  },
                ],
              },
            ],
            primary_ips: [
              {
                type: "ipv4",
                prices: [
                  {
                    location: "nbg1",
                    price_hourly: { net: "0.0010", gross: "0.00119" },
                    price_monthly: { net: "0.5000", gross: "0.5950" },
                  },
                ],
              },
            ],
          },
        });
      }
      throw new Error(`Unhandled ${request.method} ${url.pathname}`);
    });

    const result = await connectProject(connectRequest, kekSecret(), {
      client: { fetcher },
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(result.sentinel.id).toBe(7001);
    expect(createdFirewallBody).toMatchObject({
      labels: { intar_purpose: "provider_connection_sentinel" },
    });
    expect(result.catalog.serverTypes).toEqual([]);
    expect(result.canonicalWrites[0]).toMatchObject({
      operation: "resource_created",
      resourceKind: "firewall",
      externalId: 7001,
    });
    expect(JSON.stringify(result.credential)).not.toContain(connectRequest.token);
  });

  it("returns resource and action IDs for D1 persistence before the next call", async () => {
    const primaryIp = {
      id: 8001,
      created: "2026-07-22T11:59:58.250Z",
      ip: "192.0.2.10",
      labels: ownershipToLabels({
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        workspaceRef: "ws_0123456789",
        generation: 1,
      }),
      name: "intar-ip-workspace1",
      type: "ipv4" as const,
      assignee_id: null,
      assignee_type: "server",
      auto_delete: true,
      blocked: false,
      location,
    };
    const fetcher = mockFetch(() =>
      json({
        primary_ip: primaryIp,
        action: {
          id: 6001,
          status: "running",
          command: "create_primary_ip",
          progress: 0,
          started: "2026-07-22T12:00:00Z",
          finished: null,
          error: null,
          resources: [{ id: primaryIp.id, type: "primary_ip" }],
        },
      }),
    );

    const connected = await (async () => {
      const { sealCredential, parseKek } = await import("../src/crypto");
      const kek = parseKek(kekSecret());
      try {
        return await sealCredential(connectRequest.token, kek, context);
      } finally {
        kek.fill(0);
      }
    })();
    const result = await runOperation(
      {
        requestId: "request-allocate-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential: connected,
        operation: {
          kind: "create_primary_ip",
          name: primaryIp.name,
          location: "nbg1",
          ownership: {
            organizationRef: "org_0123456789",
            connectionRef: "conn_0123456789",
            workspaceRef: "ws_0123456789",
            generation: 1,
          },
        },
      },
      kekSecret(),
      { client: { fetcher }, now: () => new Date("2026-07-22T12:00:00.000Z") },
    );

    expect(result.mustPersistBeforeNextOperation).toBe(true);
    expect(result.canonicalWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: "primary_ip",
          externalId: 8001,
          actionIds: [6001],
          resourceCreatedAt: "2026-07-22T11:59:58.250Z",
        }),
        expect.objectContaining({ resourceKind: "action", externalId: 6001, state: "running" }),
      ]),
    );
  });

  it("surfaces Hetzner's availability-only capacity without claiming a quota guarantee", async () => {
    const { sealCredential, parseKek } = await import("../src/crypto");
    const kek = parseKek(kekSecret());
    const credential = await sealCredential(connectRequest.token, kek, context);
    kek.fill(0);
    let available = true;
    const fetcher = mockFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/server_types") {
        return json({
          server_types: [
            {
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
              deprecated: false,
              locations: [
                {
                  id: 1,
                  name: "nbg1",
                  available,
                  recommended: true,
                  deprecation: null,
                },
              ],
            },
          ],
          meta: {},
        });
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
                id: 43,
                name: "cx43",
                prices: [
                  {
                    location: "nbg1",
                    price_hourly: { net: "0.0100", gross: "0.0119" },
                    price_monthly: { net: "6.0000", gross: "7.1400" },
                    included_traffic: 0,
                    price_per_tb_traffic: {
                      net: "1.0000",
                      gross: "1.1900",
                    },
                  },
                ],
              },
            ],
            primary_ips: [
              {
                type: "ipv4",
                prices: [
                  {
                    location: "nbg1",
                    price_hourly: { net: "0.0010", gross: "0.00119" },
                    price_monthly: { net: "0.5000", gross: "0.5950" },
                  },
                ],
              },
            ],
          },
        });
      }
      throw new Error(`Unhandled ${request.method} ${url.pathname}`);
    });
    const request = {
      requestId: "request-preflight-0001",
      connectionId: context.connectionId,
      credentialContext: context,
      credential,
      operation: {
        kind: "preflight_capacity" as const,
        serverType: "cx43",
        permittedLocations: ["nbg1"],
        systemImage: "debian-13",
        requestedSeats: 3,
      },
    };
    const observed = await runOperation(request, kekSecret(), {
      client: { fetcher },
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(observed.data).toMatchObject({
      requestedSeats: 3,
      availableSeats: 3,
      capacityBasis: "availability_only",
      preferredLocation: "nbg1",
      reasons: [expect.stringContaining("not guaranteed until allocation")],
    });

    available = false;
    const unavailable = await runOperation(
      { ...request, requestId: "request-preflight-0002" },
      kekSecret(),
      { client: { fetcher } },
    );
    expect(unavailable.data).toMatchObject({
      availableSeats: 0,
      capacityBasis: "unavailable",
      preferredLocation: null,
    });
  });

  it("proves that a rotated same-project credential still has write access", async () => {
    const sentinel: HcloudFirewall = {
      id: 7001,
      name: connectRequest.sentinel.name,
      labels: ownershipToLabels(connectRequest.sentinel.ownership),
      rules: [],
    };
    let writeProofs = 0;
    const result = await rotateCredential(
      {
        requestId: "request-rotate-0001",
        connectionId: context.connectionId,
        credentialContext: { ...context, credentialId: "cred_0123456790", version: 2 },
        token: "r".repeat(64),
        sentinelId: sentinel.id,
        sentinelName: sentinel.name,
        ownership: connectRequest.sentinel.ownership,
      },
      kekSecret(),
      {
        client: {
          fetcher: mockFetch((request) => {
            if (request.method === "GET") return json({ firewall: sentinel });
            writeProofs += 1;
            return json({ actions: [] });
          }),
        },
      },
    );

    expect(writeProofs).toBe(1);
    expect(result.sentinel.id).toBe(sentinel.id);
    expect(JSON.stringify(result.credential)).not.toContain("r".repeat(64));
  });

  it("rejects credential rotation without exact sentinel ownership", async () => {
    let providerCalls = 0;
    for (const invalidOwnership of [
      {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
      },
      {
        organizationRef: "org_0123456789",
        connectionRef: "conn_0123456789",
        purpose: "learner_workspace",
      },
    ]) {
      await expect(
        rotateCredential(
          {
            requestId: "request-rotate-invalid",
            connectionId: context.connectionId,
            credentialContext: {
              ...context,
              credentialId: "cred_0123456799",
              version: 2,
            },
            token: "v".repeat(64),
            sentinelId: 7001,
            sentinelName: connectRequest.sentinel.name,
            ownership: invalidOwnership as never,
          },
          kekSecret(),
          {
            client: {
              fetcher: mockFetch(() => {
                providerCalls += 1;
                return json({ firewall: null });
              }),
            },
          },
        ),
      ).rejects.toThrow("Invalid provider sentinel ownership purpose");
    }
    expect(providerCalls).toBe(0);
  });

  it("does not seal a read-only credential during rotation", async () => {
    const sentinel: HcloudFirewall = {
      id: 7001,
      name: connectRequest.sentinel.name,
      labels: ownershipToLabels(connectRequest.sentinel.ownership),
      rules: [],
    };
    await expect(
      rotateCredential(
        {
          requestId: "request-rotate-0002",
          connectionId: context.connectionId,
          credentialContext: { ...context, credentialId: "cred_0123456791", version: 2 },
          token: "s".repeat(64),
          sentinelId: sentinel.id,
          sentinelName: sentinel.name,
          ownership: connectRequest.sentinel.ownership,
        },
        kekSecret(),
        {
          client: {
            fetcher: mockFetch((request) => {
              if (request.method === "GET") return json({ firewall: sentinel });
              return json(
                { error: { code: "forbidden", message: "token is read-only" } },
                { status: 403 },
              );
            }),
          },
        },
      ),
    ).rejects.toMatchObject({
      shape: { code: "hcloud_forbidden", retryable: false },
    });
  });

  it("returns a confirmed firewall deletion write for owner disconnect", async () => {
    const { sealCredential, parseKek } = await import("../src/crypto");
    const kek = parseKek(kekSecret());
    const credential = await sealCredential(connectRequest.token, kek, context);
    kek.fill(0);
    const sentinel: HcloudFirewall = {
      id: 7001,
      name: connectRequest.sentinel.name,
      labels: ownershipToLabels(connectRequest.sentinel.ownership),
      rules: [],
    };
    const observed: string[] = [];
    const result = await runOperation(
      {
        requestId: "request-disconnect-0001",
        connectionId: context.connectionId,
        credentialContext: context,
        credential,
        operation: {
          kind: "delete_resource",
          resourceKind: "firewall",
          externalId: 7001,
          deterministicName: connectRequest.sentinel.name,
          ownership: connectRequest.sentinel.ownership,
        },
      },
      kekSecret(),
      {
        client: {
          fetcher: mockFetch((request) => {
            const url = new URL(request.url);
            observed.push(`${request.method} ${url.pathname}`);
            if (request.method === "GET" && url.pathname === "/v1/firewalls") {
              return json({ firewalls: [sentinel], meta: {} });
            }
            if (request.method === "GET") return json({ firewall: sentinel });
            return new Response(null, { status: 204 });
          }),
        },
        now: () => new Date("2026-07-22T12:00:00.000Z"),
      },
    );

    expect(observed).toEqual([
      "GET /v1/firewalls",
      "GET /v1/firewalls/7001",
      "DELETE /v1/firewalls/7001",
    ]);
    expect(result.canonicalWrites).toEqual([
      expect.objectContaining({
        operation: "resource_deleted",
        resourceKind: "firewall",
        externalId: 7001,
        state: "deleted",
      }),
    ]);
  });

  it("rejects legacy mutation calls without ownership before contacting Hetzner", async () => {
    const { sealCredential, parseKek } = await import("../src/crypto");
    const kek = parseKek(kekSecret());
    const credential = await sealCredential(connectRequest.token, kek, context);
    kek.fill(0);
    let fetchCalls = 0;

    await expect(
      runOperation(
        {
          requestId: "request-legacy-reboot-0001",
          connectionId: context.connectionId,
          credentialContext: context,
          credential,
          operation: { kind: "reboot_server", serverId: 9001 } as never,
        },
        kekSecret(),
        {
          client: {
            fetcher: mockFetch(() => {
              fetchCalls += 1;
              throw new Error("must not contact Hetzner");
            }),
          },
        },
      ),
    ).rejects.toMatchObject({
      shape: {
        code: "hcloud_mutation_ownership_required",
        retryable: false,
      },
    });
    await expect(
      runOperation(
        {
          requestId: "request-legacy-delete-0001",
          connectionId: context.connectionId,
          credentialContext: context,
          credential,
          operation: {
            kind: "delete_resource",
            resourceKind: "server",
            externalId: 9001,
            name: "intar-vm-legacy",
          } as never,
        },
        kekSecret(),
        {
          client: {
            fetcher: mockFetch(() => {
              fetchCalls += 1;
              throw new Error("must not contact Hetzner");
            }),
          },
        },
      ),
    ).rejects.toMatchObject({
      shape: {
        code: "hcloud_mutation_ownership_required",
        retryable: false,
      },
    });
    expect(fetchCalls).toBe(0);
  });
});
