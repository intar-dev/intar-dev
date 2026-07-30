import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkshopRegistryToken,
  listWorkshopRegistryTokens,
  overrideWorkshopHetznerGrossCeiling,
  refreshWorkshopHetznerCostForecast,
  revokeWorkshopRegistryToken,
} from "./api";

describe("workshop Hetzner cost API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes a session forecast through the documented endpoint", async () => {
    const payload = { label: "estimated Hetzner cost" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshWorkshopHetznerCostForecast("org/one", "session two"),
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
      overrideWorkshopHetznerGrossCeiling("org-a", "session-a"),
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
