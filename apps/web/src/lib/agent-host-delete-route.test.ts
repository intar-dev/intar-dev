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
  const state = {
    activeBuilds: [] as Array<{ buildId: string }>,
  };
  const db = {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(() => {
          return Promise.resolve(state.activeBuilds);
        }),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }),
  };
  return { db, drizzle: vi.fn(() => db), state };
});

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeMock);
vi.mock("@/lib/personal-host-retirement", () => hostRetirementMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { DELETE } from "@/pages/api/agent/hosts/[hostId]";

const BETA_ADMISSION = {
  sourceInviteId: "invite-1",
  sourceLeaseId: "lease-1",
  grantedAt: 123,
};

describe("personal host removal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.activeBuilds = [];
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1", betaAdmission: BETA_ADMISSION },
    });
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "agent",
      disabled: false,
      connected: false,
      active_session_id: null,
    });
    hostRetirementMock.retirePersonalHost.mockResolvedValue(true);
    hostRuntimeMock.retireHostRuntime.mockResolvedValue(undefined);
  });

  it("accepts a bodyless delete after the Worker edge guard", async () => {
    const response = await removeHostRequest();

    expect(response.status).toBe(200);
  });

  it("requires the daemon to disconnect before removal", async () => {
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "agent",
      connected: true,
      active_session_id: "session-1",
    });

    const response = await removeHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "host_must_disconnect",
      hostId: "host-1",
    });
    expect(hostRetirementMock.retirePersonalHost).not.toHaveBeenCalled();
  });

  it("retires a drained host while preserving its database identity", async () => {
    const response = await removeHostRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      hostId: "host-1",
    });
    expect(hostRetirementMock.retirePersonalHost).toHaveBeenCalledWith({
      d1: "test-db",
      hostId: "host-1",
      userId: "user-1",
      betaAdmission: BETA_ADMISSION,
    });
    expect(hostRuntimeMock.retireHostRuntime).toHaveBeenCalledWith("host-1");
  });

  it("requires active builder work to be drained", async () => {
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "builder",
      connected: false,
      active_session_id: null,
    });
    dbMock.state.activeBuilds = [{ buildId: "build-1" }];

    const response = await removeHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "host_has_active_builds",
    });
    expect(hostRetirementMock.retirePersonalHost).not.toHaveBeenCalled();
  });

  it("fails closed when active work or admission changes after preflight", async () => {
    hostRetirementMock.retirePersonalHost.mockResolvedValue(false);

    const response = await removeHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "host_remove_conflict",
      hostId: "host-1",
    });
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
  });
});

async function removeHostRequest(): Promise<Response> {
  return DELETE({
    request: new Request("https://intar.test/api/agent/hosts/host-1", {
      method: "DELETE",
    }),
    params: { hostId: "host-1" },
  } as never);
}
