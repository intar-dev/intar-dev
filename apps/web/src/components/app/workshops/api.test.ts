import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectWorkshopProvider,
  createWorkshopSession,
  createWorkshopRegistryToken,
  listWorkshopRegistryTokens,
  overrideWorkshopCostCeiling,
  refreshWorkshopCostForecast,
  rotateWorkshopProviderCredential,
  revokeWorkshopRegistryToken,
} from "./api";

describe("workshop session API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends workspace enrollment independently from the member role", async () => {
    const payload = { session: { id: "session-a" } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createWorkshopSession("org/one", {
        templateRevisionId: "revision-a",
        title: "Platform workshop",
        startsAt: 1_900_000_000_000,
        members: [
          {
            userId: "facilitator-a",
            role: "facilitator",
            workspaceEnabled: true,
          },
        ],
        runtimeProvider: { profileId: "hetzner-cpx42", connectionId: "hcloud-a" },
      }),
    ).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org%2Fone/workshop-sessions",
      {
        credentials: "include",
        method: "POST",
        body: JSON.stringify({
          templateRevisionId: "revision-a",
          title: "Platform workshop",
          startsAt: 1_900_000_000_000,
          members: [
            {
              userId: "facilitator-a",
              role: "facilitator",
              workspaceEnabled: true,
            },
          ],
          runtimeProvider: {
            profileId: "hetzner-cpx42",
            connectionId: "hcloud-a",
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
  });
});

describe("workshop provider connection API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses one generic endpoint for a GCP BYOK connection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "gcp-a" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const credential = JSON.stringify({
      type: "service_account",
      project_id: "intar-pilot-123",
      private_key: "secret",
    });

    await connectWorkshopProvider("org/one", {
      providerKind: "gcp_compute",
      credential,
      displayName: "GCP pilot",
      approvedLocations: ["europe-west3-a"],
      maxConcurrentAllocations: 2,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org%2Fone/workshop-providers",
      {
        credentials: "include",
        method: "POST",
        body: JSON.stringify({
          providerKind: "gcp_compute",
          credential,
          displayName: "GCP pilot",
          approvedLocations: ["europe-west3-a"],
          maxConcurrentAllocations: 2,
        }),
        headers: { "content-type": "application/json" },
      },
    );
  });

  it("rotates either provider through the connection-scoped endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ state: "active" }));
    vi.stubGlobal("fetch", fetchMock);

    await rotateWorkshopProviderCredential("org-a", "provider/gcp", "new-key");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org-a/workshop-providers/provider%2Fgcp/rotate",
      {
        credentials: "include",
        method: "POST",
        body: JSON.stringify({ credential: "new-key" }),
        headers: { "content-type": "application/json" },
      },
    );
  });
});

describe("workshop provider cost API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes a session forecast through the documented endpoint", async () => {
    const payload = { label: "estimated Hetzner cost" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshWorkshopCostForecast("org/one", "session two"),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org%2Fone/workshop-sessions/session%20two/cost/refresh",
      {
        credentials: "include",
        method: "POST",
        headers: {},
      },
    );
  });

  it("requests an owner ceiling override without placing data in the URL", async () => {
    const payload = {
      sessionId: "session-a",
      overriddenAt: 123,
      overriddenBy: "owner-a",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      overrideWorkshopCostCeiling("org-a", "session-a"),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org-a/workshop-sessions/session-a/cost/override",
      {
        credentials: "include",
        method: "POST",
        headers: {},
      },
    );
  });
});

describe("workshop registry token API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists tokens through the encoded organization endpoint", async () => {
    const payload = {
      tokens: [
        {
          id: "token-a",
          name: "Workshop publisher",
          tokenPrefix: "intar_ws_1234567890",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: 1_800_000_000_000,
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWorkshopRegistryTokens("org/one")).resolves.toEqual(
      payload,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org%2Fone/workshops/tokens",
      {
        credentials: "include",
        headers: {},
      },
    );
  });

  it("creates a token through the encoded organization endpoint", async () => {
    const payload = {
      id: "token-a",
      name: "CI publisher",
      tokenPrefix: "intar_ws_1234567890",
      token: "intar_ws_single-use-secret",
      lastUsedAt: null,
      expiresAt: 1_900_000_000_000,
      revokedAt: null,
      createdAt: 1_800_000_000_000,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createWorkshopRegistryToken("org/one", {
        name: "CI publisher",
        expiresAfterMinutes: 120,
      }),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org%2Fone/workshops/tokens",
      {
        credentials: "include",
        method: "POST",
        body: JSON.stringify({
          name: "CI publisher",
          expiresAfterMinutes: 120,
        }),
        headers: { "content-type": "application/json" },
      },
    );
  });

  it("revokes a token through encoded organization and token endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      revokeWorkshopRegistryToken("org/one", "token/two"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/org%2Fone/workshops/tokens/token%2Ftwo",
      {
        credentials: "include",
        method: "DELETE",
        headers: {},
      },
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
