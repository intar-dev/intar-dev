import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn(
    (body: unknown, init?: ResponseInit) => Response.json(body, init),
  ),
  requireAdminUserContext: vi.fn(),
}));
const snapshotMock = vi.hoisted(() => ({
  loadAdminFleetSnapshot: vi.fn(),
  loadAdminFleetArchivedRunDetail: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/admin-fleet-snapshot", () => snapshotMock);

import { GET as fleetSnapshot } from "@/pages/api/admin/fleet-snapshot";
import { GET as archiveDetail } from "@/pages/api/admin/fleet-snapshot/runs/[runId]";

describe("admin fleet snapshot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-user" },
    });
    snapshotMock.loadAdminFleetSnapshot.mockResolvedValue({
      hostRecords: [],
      archiveTotalCount: 0,
    });
    snapshotMock.loadAdminFleetArchivedRunDetail.mockResolvedValue(null);
  });

  it("requires admin access and marks snapshot responses private/no-store", async () => {
    const response = await fleetSnapshot(routeContext("/api/admin/fleet-snapshot"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(snapshotMock.loadAdminFleetSnapshot).toHaveBeenCalledWith({
      userId: "admin-user",
      archiveOffset: 0,
      includeArchiveSummaries: true,
    });
  });

  it("does not read fleet data when admin access is denied", async () => {
    agentBridgeMock.requireAdminUserContext.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });

    const response = await fleetSnapshot(routeContext("/api/admin/fleet-snapshot"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(snapshotMock.loadAdminFleetSnapshot).not.toHaveBeenCalled();
  });

  it("passes a validated archive offset to the bounded snapshot", async () => {
    const response = await fleetSnapshot(
      routeContext("/api/admin/fleet-snapshot?archiveOffset=100"),
    );

    expect(response.status).toBe(200);
    expect(snapshotMock.loadAdminFleetSnapshot).toHaveBeenCalledWith({
      userId: "admin-user",
      archiveOffset: 100,
      includeArchiveSummaries: true,
    });
  });

  it("can omit archive summaries from the live fleet poll", async () => {
    const response = await fleetSnapshot(
      routeContext(
        "/api/admin/fleet-snapshot?includeArchiveSummaries=0",
      ),
    );

    expect(response.status).toBe(200);
    expect(snapshotMock.loadAdminFleetSnapshot).toHaveBeenCalledWith({
      userId: "admin-user",
      archiveOffset: 0,
      includeArchiveSummaries: false,
    });
  });

  it("rejects an invalid archive offset without reading D1", async () => {
    const response = await fleetSnapshot(
      routeContext("/api/admin/fleet-snapshot?archiveOffset=-1"),
    );

    expect(response.status).toBe(400);
    expect(snapshotMock.loadAdminFleetSnapshot).not.toHaveBeenCalled();
  });

  it("keeps archive detail host-scoped and private/no-store", async () => {
    const response = await archiveDetail(
      routeContext(
        "/api/admin/fleet-snapshot/runs/run-1?hostId=host-1",
        "run-1",
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(snapshotMock.loadAdminFleetArchivedRunDetail).toHaveBeenCalledWith({
      userId: "admin-user",
      runId: "run-1",
      hostId: "host-1",
    });
  });
});

function routeContext(path: string, runId?: string) {
  const url = new URL(path, "https://intar.test");
  return {
    request: new Request(url),
    params: runId ? { runId } : {},
    url,
  } as never;
}
