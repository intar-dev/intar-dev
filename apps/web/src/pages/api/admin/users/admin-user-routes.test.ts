import { beforeEach, describe, expect, it, vi } from "vitest";

const requestSecurityMock = vi.hoisted(() => ({
  NO_STORE_HEADERS: {
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
  },
}));
const agentBridgeMock = vi.hoisted(() => ({
  requireAdminUserContext: vi.fn(),
}));
const betaAdminGuardMock = vi.hoisted(() => ({
  setPlatformUserBanned: vi.fn(),
  setPlatformUserRole: vi.fn(),
}));

vi.mock("@/lib/request-security", () => requestSecurityMock);
vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/beta-admin-guard", () => betaAdminGuardMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { appError } from "@/lib/app-error";
import { POST as updateBan } from "@/pages/api/admin/users/[userId]/ban";
import { POST as updateRole } from "@/pages/api/admin/users/[userId]/role";

describe("admin user mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "actor-admin" },
    });
    betaAdminGuardMock.setPlatformUserBanned.mockResolvedValue(undefined);
    betaAdminGuardMock.setPlatformUserRole.mockResolvedValue(undefined);
  });

  it("returns an unauthenticated ban response with no-store headers", async () => {
    agentBridgeMock.requireAdminUserContext.mockResolvedValueOnce({
      ok: false,
      response: Response.json(
        { error: "authentication required", code: "authentication_required" },
        { status: 401 },
      ),
    });
    const request = mutationRequest("ban", { banned: true });

    const response = await updateBan(routeContext(request, "target-user"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "authentication required",
      code: "authentication_required",
    });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(agentBridgeMock.requireAdminUserContext).toHaveBeenCalledWith(
      request,
    );
    expect(betaAdminGuardMock.setPlatformUserBanned).not.toHaveBeenCalled();
  });

  it.each([
    ["role", updateRole],
    ["ban", updateBan],
  ] as const)("rejects malformed JSON for the %s endpoint", async (action, route) => {
    const request = mutationRequest(action, "{");

    const response = await route(routeContext(request, "target-user"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "a JSON object is required",
      code: "invalid_json",
    });
    expect(betaAdminGuardMock.setPlatformUserRole).not.toHaveBeenCalled();
    expect(betaAdminGuardMock.setPlatformUserBanned).not.toHaveBeenCalled();
  });

  it("rejects roles outside the app-owned role set", async () => {
    const request = mutationRequest("role", { role: "owner" });

    const response = await updateRole(routeContext(request, "target-user"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "role must be user or admin",
      code: "role_invalid",
    });
    expect(betaAdminGuardMock.setPlatformUserRole).not.toHaveBeenCalled();
  });

  it.each(["true", 1, null, undefined])(
    "rejects invalid ban state %s",
    async (banned) => {
      const request = mutationRequest("ban", { banned });

      const response = await updateBan(routeContext(request, "target-user"));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "banned must be a boolean",
        code: "ban_state_invalid",
      });
      expect(betaAdminGuardMock.setPlatformUserBanned).not.toHaveBeenCalled();
    },
  );

  it("forwards the authenticated actor and trimmed target for role updates", async () => {
    const request = mutationRequest("role", { role: "admin" });

    const response = await updateRole(routeContext(request, " target-user "));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: true });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(betaAdminGuardMock.setPlatformUserRole).toHaveBeenCalledWith({
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
      role: "admin",
    });
  });

  it("forwards ban state and reason through the guarded service", async () => {
    const request = mutationRequest("ban", {
      banned: true,
      reason: "Access revoked by admin",
    });

    const response = await updateBan(routeContext(request, "target-user"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: true });
    expect(betaAdminGuardMock.setPlatformUserBanned).toHaveBeenCalledWith({
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
      banned: true,
      reason: "Access revoked by admin",
    });
  });

  it("preserves guarded service conflicts in the role response", async () => {
    betaAdminGuardMock.setPlatformUserRole.mockRejectedValueOnce(
      appError(
        409,
        "last_active_admin",
        "the last active administrator cannot be demoted",
      ),
    );
    const request = mutationRequest("role", { role: "user" });

    const response = await updateRole(routeContext(request, "target-user"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "the last active administrator cannot be demoted",
      code: "last_active_admin",
    });
  });

  it("maps unexpected ban service failures to the route fallback", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    betaAdminGuardMock.setPlatformUserBanned.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const request = mutationRequest("ban", { banned: false });

    const response = await updateBan(routeContext(request, "target-user"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "the platform ban could not be updated",
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});

function mutationRequest(
  action: "ban" | "role",
  body: Record<string, unknown> | string,
): Request {
  return new Request(`https://intar.test/api/admin/users/target-user/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function routeContext(request: Request, userId: string) {
  return {
    request,
    params: { userId },
  } as never;
}
