import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  buildStoredBridgeStatus: vi.fn(),
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  loadHostForUser: vi.fn(),
  parseInventory: vi.fn(),
  requireAdminUserContext: vi.fn(),
}));
const hostRuntimeMock = vi.hoisted(() => ({ retireHostRuntime: vi.fn() }));
const hostRetirementMock = vi.hoisted(() => ({
  retirePersonalHost: vi.fn(),
}));
const dbMock = vi.hoisted(() => {
  const state = { writes: [] as Array<Record<string, unknown>> };
  const query = {
    set: vi.fn((values: Record<string, unknown>) => {
      state.writes.push(values);
      return query;
    }),
    where: vi.fn(() => Promise.resolve()),
  };
  const db = { update: vi.fn(() => query) };
  return { db, drizzle: vi.fn(() => db), state };
});

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeMock);
vi.mock("@/lib/personal-host-retirement", () => hostRetirementMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { PATCH } from "@/pages/api/agent/hosts/[hostId]";

const BETA_ADMISSION = {
  sourceInviteId: "invite-1",
  sourceLeaseId: "lease-1",
  grantedAt: 123,
};

describe("host sponsor route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.writes = [];
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1", betaAdmission: BETA_ADMISSION },
    });
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "agent",
      disabled: false,
    });
  });

  it("refuses an operator who is not an admin", async () => {
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });

    const response = await patchHost({ provider: "hetzner" });

    expect(response.status).toBe(403);
    expect(dbMock.state.writes).toEqual([]);
  });

  it("refuses a sponsor outside the list", async () => {
    const response = await patchHost({ provider: "aws" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "provider must be hetzner, namespace, other, or null",
    });
    expect(dbMock.state.writes).toEqual([]);
  });

  it("refuses a body with no sponsor key", async () => {
    const response = await patchHost({});

    expect(response.status).toBe(400);
    expect(dbMock.state.writes).toEqual([]);
  });

  it("stores the sponsor", async () => {
    const response = await patchHost({ provider: "hetzner" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hostId: "host-1",
      provider: "hetzner",
    });
    expect(dbMock.state.writes).toHaveLength(1);
    expect(dbMock.state.writes[0]).toMatchObject({ provider: "hetzner" });
    expect(typeof dbMock.state.writes[0]!.updatedAt).toBe("number");
  });

  it("clears the sponsor", async () => {
    const response = await patchHost({ provider: null });

    expect(response.status).toBe(200);
    expect(dbMock.state.writes[0]).toMatchObject({ provider: null });
  });

  it("reports an unknown host", async () => {
    agentBridgeMock.loadHostForUser.mockResolvedValue(null);

    const response = await patchHost({ provider: "namespace" });

    expect(response.status).toBe(404);
    expect(dbMock.state.writes).toEqual([]);
  });
});

async function patchHost(body: Record<string, unknown>): Promise<Response> {
  return PATCH({
    request: new Request("https://intar.test/api/agent/hosts/host-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: { hostId: "host-1" },
  } as never);
}
