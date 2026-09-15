import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  requireUserContext: vi.fn(),
}));
const fleetMapMock = vi.hoisted(() => ({ loadFleetMap: vi.fn() }));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/fleet-map", () => fleetMapMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { GET } from "@/pages/api/fleet/map";

const SNAPSHOT = {
  generatedAt: 1_762_041_660_000,
  hosts: [
    {
      latitude: 49.4521,
      longitude: 11.0767,
      city: "Nuremberg",
      country: "Germany",
      state: "healthy",
      cpuMillis: 64_000,
      memoryMib: 262_144,
      provider: "hetzner",
    },
  ],
  unlocatedHostCount: 0,
  pendingHostCount: 0,
  truncatedHostCount: 0,
};

describe("fleet map route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1" },
    });
    fleetMapMock.loadFleetMap.mockResolvedValue(SNAPSHOT);
  });

  it("refuses a caller without a session", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await getMap();

    expect(response.status).toBe(401);
    expect(fleetMapMock.loadFleetMap).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns the placed fleet without a cache", async () => {
    const response = await getMap();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual(SNAPSHOT);
  });

  it("hides an internal failure behind one message", async () => {
    fleetMapMock.loadFleetMap.mockRejectedValue(
      new Error("D1_ERROR: no such table: host_geo_locations"),
    );

    const response = await getMap();

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("failed to load the fleet map");
    expect(JSON.stringify(body)).not.toContain("host_geo_locations");
  });
});

async function getMap(): Promise<Response> {
  return GET({
    request: new Request("https://intar.test/api/fleet/map"),
  } as never);
}
