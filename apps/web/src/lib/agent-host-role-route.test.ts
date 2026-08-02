import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  buildStoredBridgeStatus: vi.fn(),
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  loadHostForUser: vi.fn(),
  parseInventory: vi.fn(),
  requireAdminUserContext: vi.fn(),
  resolveRequestOrigin: vi.fn(),
}));
const dbMock = vi.hoisted(() => ({
  db: { update: vi.fn() },
  drizzle: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { POST } from "@/pages/api/agent/hosts";

describe("agent host role identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.drizzle.mockReturnValue(dbMock.db);
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1" },
    });
    agentBridgeMock.loadHostForUser.mockResolvedValue({
      id: "host-1",
      role: "agent",
    });
  });

  it("refuses to repurpose an existing agent as a builder", async () => {
    const request = new Request("https://intar.test/api/agent/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", role: "builder" }),
    });

    const response = await POST({
      request,
      url: new URL(request.url),
    } as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "host roles are immutable; create a new host for the requested role",
      code: "host_role_immutable",
      hostId: "host-1",
      currentRole: "agent",
      requestedRole: "builder",
    });
    expect(dbMock.db.update).not.toHaveBeenCalled();
  });
});
