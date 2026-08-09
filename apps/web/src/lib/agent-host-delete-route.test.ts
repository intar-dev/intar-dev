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
const hostRuntimeMock = vi.hoisted(() => ({
  retireHostRuntime: vi.fn(),
}));
const hostDeletionMock = vi.hoisted(() => ({
  deleteAgentHostPreservingHistory: vi.fn(),
  nonDetachableWorkshopPublication: vi.fn(() => "unfinished-publication"),
}));
const dbMock = vi.hoisted(() => {
  const state = {
    referencedRuns: [] as Array<{ runId: string }>,
    activeWorkshopRuntimes: [] as Array<{ executionId: string }>,
    unfinishedWorkshopPublications: [] as Array<{ publicationId: string }>,
    activeBuilds: [] as Array<{ buildId: string }>,
    limitedSelectCall: 0,
  };
  const db = {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(() => {
          const rows =
            state.limitedSelectCall === 0
              ? state.referencedRuns
              : state.limitedSelectCall === 1
                ? state.activeWorkshopRuntimes
                : state.limitedSelectCall === 2
                  ? state.unfinishedWorkshopPublications
                  : state.activeBuilds;
          state.limitedSelectCall += 1;
          return Promise.resolve(rows);
        }),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }),
  };
  return {
    db,
    drizzle: vi.fn(() => db),
    state,
  };
});

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/agent-host-deletion", () => hostDeletionMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { DELETE } from "@/pages/api/agent/hosts/[hostId]";

describe("agent host deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.referencedRuns = [];
    dbMock.state.activeWorkshopRuntimes = [];
    dbMock.state.unfinishedWorkshopPublications = [];
    dbMock.state.activeBuilds = [];
    dbMock.state.limitedSelectCall = 0;
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1" },
    });
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "agent",
    });
    hostDeletionMock.deleteAgentHostPreservingHistory.mockResolvedValue(true);
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
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).not.toHaveBeenCalled();
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
  });

  it("deletes a drained builder through the history-preserving transaction", async () => {
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
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).toHaveBeenCalledWith(dbMock.db, {
      hostId: "host-1",
      userId: "user-1",
    });
    expect(hostRuntimeMock.retireHostRuntime).toHaveBeenCalledWith("host-1");
  });

  it("requires active workshop runtimes to be drained or recovered first", async () => {
    dbMock.state.activeWorkshopRuntimes = [
      { executionId: "workshop-execution-1" },
    ];

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "host has active workshop runtimes and must be drained or recovered first",
      code: "host_has_active_workshop_runtimes",
      hostId: "host-1",
    });
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).not.toHaveBeenCalled();
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
  });

  it("requires unfinished workshop publications to complete or clean up first", async () => {
    dbMock.state.unfinishedWorkshopPublications = [
      { publicationId: "publication-1" },
    ];

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "host has unfinished workshop publications and must be completed or cleaned up first",
      code: "host_has_unfinished_workshop_publications",
      hostId: "host-1",
    });
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).not.toHaveBeenCalled();
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
  });

  it("requires a builder with active image builds to be drained first", async () => {
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "builder",
    });
    dbMock.state.activeBuilds = [{ buildId: "build-1" }];

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "builder host has active image builds and must be drained first",
      code: "host_has_active_builds",
      hostId: "host-1",
    });
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).not.toHaveBeenCalled();
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
  });

  it("fails closed when a run appears between the initial check and delete", async () => {
    hostDeletionMock.deleteAgentHostPreservingHistory.mockResolvedValue(false);

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "host deletion conflicted with new history, unfinished work, or a concurrent update",
      code: "host_delete_conflict",
      hostId: "host-1",
    });
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a build is assigned after the builder precheck", async () => {
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "builder",
    });
    // The precheck sees no active build. An empty RETURNING result represents
    // the atomic NOT EXISTS guard observing a raced assignment.
    hostDeletionMock.deleteAgentHostPreservingHistory.mockResolvedValue(false);

    const response = await deleteHostRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "host deletion conflicted with new history, unfinished work, or a concurrent update",
      code: "host_delete_conflict",
      hostId: "host-1",
    });
    expect(
      hostDeletionMock.deleteAgentHostPreservingHistory,
    ).toHaveBeenCalledTimes(1);
    expect(hostRuntimeMock.retireHostRuntime).not.toHaveBeenCalled();
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
