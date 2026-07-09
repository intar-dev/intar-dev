import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  buildStoredBridgeStatus: vi.fn(),
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  loadHostForUser: vi.fn(),
  parseInventory: vi.fn(),
  requireAdminUserContext: vi.fn(),
}));
const schedulerMock = vi.hoisted(() => ({
  assignQueuedImageBuilds: vi.fn(),
}));
const hostRuntimeMock = vi.hoisted(() => ({
  retireHostRuntime: vi.fn(),
}));
const dbMock = vi.hoisted(() => {
  const state = {
    referencedRuns: [] as Array<{ runId: string }>,
    deletedHosts: [] as Array<{ id: string }>,
  };
  const db = {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(() => Promise.resolve(state.referencedRuns)),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }),
    delete: vi.fn(() => {
      const query = {
        where: vi.fn(),
        returning: vi.fn(() => Promise.resolve(state.deletedHosts)),
      };
      query.where.mockReturnValue(query);
      return query;
    }),
    update: vi.fn(() => {
      const query = {
        set: vi.fn(),
        where: vi.fn(),
      };
      query.set.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }),
    batch: vi.fn(() =>
      Promise.resolve([undefined, undefined, state.deletedHosts]),
    ),
  };
  return {
    db,
    drizzle: vi.fn(() => db),
    state,
  };
});

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/build-scheduler", () => schedulerMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { DELETE } from "@/pages/api/agent/hosts/[hostId]";

describe("agent host deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.referencedRuns = [];
    dbMock.state.deletedHosts = [{ id: "host-1" }];
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1" },
    });
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "agent",
    });
    hostRuntimeMock.retireHostRuntime.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to delete a host referenced by any scenario run history", async () => {
    dbMock.state.referencedRuns = [{ runId: "run-terminal" }];

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "host has scenario run history and cannot be deleted",
      code: "host_has_run_history",
      hostId: "host-1",
    });
    expect(dbMock.db.delete).not.toHaveBeenCalled();
    expect(dbMock.db.batch).not.toHaveBeenCalled();
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("keeps builder cleanup and rescheduling for an unreferenced host", async () => {
    const now = 1_762_041_660_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "builder",
    });

    const response = await deleteHostRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      hostId: "host-1",
    });
    expect(dbMock.db.batch).toHaveBeenCalledTimes(1);
    expect(dbMock.db.delete).toHaveBeenCalledTimes(1);
    expect(hostRuntimeMock.retireHostRuntime).toHaveBeenCalledWith("host-1");
    expect(schedulerMock.assignQueuedImageBuilds).toHaveBeenCalledWith(
      dbMock.db,
      now,
    );
    expect(
      dbMock.db.batch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      schedulerMock.assignQueuedImageBuilds.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("fails closed when a run appears between the initial check and delete", async () => {
    dbMock.state.deletedHosts = [];

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "host deletion conflicted with a new run or concurrent update",
      code: "host_delete_conflict",
      hostId: "host-1",
    });
    expect(dbMock.db.delete).toHaveBeenCalledTimes(1);
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });
});

async function deleteHostRequest(): Promise<Response> {
  return DELETE({
    request: new Request("https://intar.test/api/agent/hosts/host-1", {
      method: "DELETE",
    }),
    params: { hostId: "host-1" },
  } as never);
}
