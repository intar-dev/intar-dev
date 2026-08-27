import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  jsonResponse: vi.fn(
    (body: unknown, init?: ResponseInit) => Response.json(body, init),
  ),
  requireAdminUserContext: vi.fn(),
}));
const archiveMock = vi.hoisted(() => ({
  loadAdminRunArchivePage: vi.fn(),
  loadAdminArchivedRunDetail: vi.fn(),
  parseAdminRunArchiveCursor: vi.fn(),
}));
const scenarioRunsMock = vi.hoisted(() => ({
  deleteFinishedScenarioRunForAdmin: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => authMock);
vi.mock("@/lib/admin-fleet-snapshot", () => archiveMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);

import { GET as listRuns } from "@/pages/api/admin/runs/index";
import {
  DELETE as deleteRun,
  GET as getRun,
} from "@/pages/api/admin/runs/[runId]";

describe("admin run archive routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-user", isAdmin: true },
    });
    archiveMock.parseAdminRunArchiveCursor.mockReturnValue(undefined);
    archiveMock.loadAdminRunArchivePage.mockResolvedValue({
      runs: [],
      totalCount: 0,
      nextCursor: null,
    });
    archiveMock.loadAdminArchivedRunDetail.mockResolvedValue(null);
    scenarioRunsMock.deleteFinishedScenarioRunForAdmin.mockResolvedValue(
      undefined,
    );
  });

  it("lists global runs without passing an owner scope", async () => {
    const response = await listRuns(routeContext("/api/admin/runs"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(archiveMock.loadAdminRunArchivePage).toHaveBeenCalledWith({});
  });

  it("passes only the validated opaque cursor", async () => {
    const cursor = { archiveAt: 123, runId: "run-1" };
    archiveMock.parseAdminRunArchiveCursor.mockReturnValueOnce(cursor);

    const response = await listRuns(
      routeContext("/api/admin/runs?cursor=opaque-cursor"),
    );

    expect(response.status).toBe(200);
    expect(archiveMock.parseAdminRunArchiveCursor).toHaveBeenCalledWith(
      "opaque-cursor",
    );
    expect(archiveMock.loadAdminRunArchivePage).toHaveBeenCalledWith({ cursor });
  });

  it("rejects an invalid cursor before reading archive data", async () => {
    archiveMock.parseAdminRunArchiveCursor.mockReturnValueOnce(null);

    const response = await listRuns(
      routeContext("/api/admin/runs?cursor=invalid"),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(archiveMock.loadAdminRunArchivePage).not.toHaveBeenCalled();
  });

  it("does not read or delete runs when admin access is denied", async () => {
    authMock.requireAdminUserContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });

    const [listResponse, detailResponse, deleteResponse] = await Promise.all([
      listRuns(routeContext("/api/admin/runs")),
      getRun(routeContext("/api/admin/runs/run-1", "run-1")),
      deleteRun(routeContext("/api/admin/runs/run-1", "run-1", "DELETE")),
    ]);

    expect([listResponse.status, detailResponse.status, deleteResponse.status]).toEqual([
      403, 403, 403,
    ]);
    for (const response of [listResponse, detailResponse, deleteResponse]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(archiveMock.loadAdminRunArchivePage).not.toHaveBeenCalled();
    expect(archiveMock.loadAdminArchivedRunDetail).not.toHaveBeenCalled();
    expect(
      scenarioRunsMock.deleteFinishedScenarioRunForAdmin,
    ).not.toHaveBeenCalled();
  });

  it("loads a foreign archived run by its globally unique id", async () => {
    archiveMock.loadAdminArchivedRunDetail.mockResolvedValueOnce({
      id: "run-1",
    });

    const response = await getRun(
      routeContext("/api/admin/runs/run-1", "run-1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(archiveMock.loadAdminArchivedRunDetail).toHaveBeenCalledWith({
      runId: "run-1",
    });
  });

  it("deletes a foreign terminal run through the admin-only path", async () => {
    archiveMock.loadAdminArchivedRunDetail.mockResolvedValueOnce({
      id: "run-1",
    });
    const response = await deleteRun(
      routeContext("/api/admin/runs/run-1", "run-1", "DELETE"),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      scenarioRunsMock.deleteFinishedScenarioRunForAdmin,
    ).toHaveBeenCalledWith({
      runId: "run-1",
      actorUserId: "admin-user",
    });
  });
});

function routeContext(path: string, runId?: string, method = "GET") {
  const url = new URL(path, "https://intar.test");
  return {
    request: new Request(url, { method }),
    params: runId ? { runId } : {},
    url,
  } as never;
}
