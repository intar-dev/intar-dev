import { afterEach, describe, expect, it, vi } from "vitest";
import {
  overrideWorkshopHetznerGrossCeiling,
  refreshWorkshopHetznerCostForecast,
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
