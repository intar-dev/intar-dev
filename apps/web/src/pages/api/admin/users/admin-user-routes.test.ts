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
  setPlatformUserRole: vi.fn(),
}));
const deletionStoreMock = vi.hoisted(() => ({
  assertPlatformUserDeletionAllowed: vi.fn(),
  finalizePlatformUserDeletion: vi.fn(),
  listPlatformUsers: vi.fn(),
}));
const revocationStoreMock = vi.hoisted(() => ({
  revokeBetaUser: vi.fn(),
}));
const revocationMock = vi.hoisted(() => ({
  cleanupBetaRevocation: vi.fn(),
  getBetaRevocationStatus: vi.fn(),
}));

vi.mock("@/lib/request-security", () => requestSecurityMock);
vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/beta-admin-guard", () => betaAdminGuardMock);
vi.mock("@/lib/platform-user-deletion-store", () => deletionStoreMock);
vi.mock("@/lib/beta-access-revocation-store", () => revocationStoreMock);
vi.mock("@/lib/beta-access-revocation", () => revocationMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { appError } from "@/lib/app-error";
import { DELETE as deleteUser } from "@/pages/api/admin/users/[userId]/index";
import { POST as updateRole } from "@/pages/api/admin/users/[userId]/role";
import { GET as listUsers } from "@/pages/api/admin/users/index";

describe("admin user mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "actor-admin" },
    });
    betaAdminGuardMock.setPlatformUserRole.mockResolvedValue(undefined);
    deletionStoreMock.assertPlatformUserDeletionAllowed.mockResolvedValue(
      undefined,
    );
    deletionStoreMock.finalizePlatformUserDeletion.mockResolvedValue(undefined);
    deletionStoreMock.listPlatformUsers.mockResolvedValue([
      { id: "target-user", name: "Target User" },
    ]);
    revocationStoreMock.revokeBetaUser.mockRejectedValue(
      appError(409, "beta_user_not_active", "Beta access is not active"),
    );
    revocationMock.getBetaRevocationStatus.mockResolvedValue(null);
    revocationMock.cleanupBetaRevocation.mockResolvedValue(undefined);
  });

  it.each([
    ["list", listUsers, listRequest()],
    ["delete", deleteUser, deleteRequest()],
  ] as const)(
    "returns an unauthenticated %s response with no-store headers",
    async (_name, route, request) => {
      agentBridgeMock.requireAdminUserContext.mockResolvedValueOnce({
        ok: false,
        response: Response.json(
          { error: "authentication required", code: "authentication_required" },
          { status: 401 },
        ),
      });

      const response = await route(routeContext(request, "target-user"));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "authentication required",
        code: "authentication_required",
      });
      expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(
        deletionStoreMock.finalizePlatformUserDeletion,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON for the role endpoint", async () => {
    const request = roleRequest("{");

    const response = await updateRole(routeContext(request, "target-user"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "a JSON object is required",
      code: "invalid_json",
    });
    expect(betaAdminGuardMock.setPlatformUserRole).not.toHaveBeenCalled();
  });

  it("lists only users returned by the app-owned store", async () => {
    const response = await listUsers(routeContext(listRequest(), ""));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: [{ id: "target-user", name: "Target User" }],
    });
    expect(deletionStoreMock.listPlatformUsers).toHaveBeenCalledWith("test-db");
  });

  it("rejects roles outside the app-owned role set", async () => {
    const response = await updateRole(
      routeContext(roleRequest({ role: "owner" }), "target-user"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "role must be user or admin",
      code: "role_invalid",
    });
  });

  it("forwards the authenticated actor and trimmed target for role updates", async () => {
    const response = await updateRole(
      routeContext(roleRequest({ role: "admin" }), " target-user "),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: true });
    expect(betaAdminGuardMock.setPlatformUserRole).toHaveBeenCalledWith({
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
      role: "admin",
    });
  });

  it("deletes a user who never had beta access", async () => {
    const response = await deleteUser(
      routeContext(deleteRequest(), " target-user "),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(
      deletionStoreMock.assertPlatformUserDeletionAllowed,
    ).toHaveBeenCalledWith({
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
    });
    expect(revocationMock.cleanupBetaRevocation).not.toHaveBeenCalled();
    expect(deletionStoreMock.finalizePlatformUserDeletion).toHaveBeenCalledWith({
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
    });
  });

  it("revokes and cleans active beta access before deletion", async () => {
    revocationStoreMock.revokeBetaUser.mockResolvedValueOnce({
      revocationId: "revocation-1",
    });

    const response = await deleteUser(
      routeContext(deleteRequest(), "target-user"),
    );

    expect(response.status).toBe(200);
    expect(revocationStoreMock.revokeBetaUser).toHaveBeenCalledWith({
      d1: "test-db",
      userId: "target-user",
      actorUserId: "actor-admin",
      reason: "admin_deleted",
    });
    expect(revocationMock.cleanupBetaRevocation).toHaveBeenCalledWith({
      userId: "target-user",
      revocationId: "revocation-1",
      actorUserId: "actor-admin",
    });
    expect(
      deletionStoreMock.finalizePlatformUserDeletion,
    ).toHaveBeenCalledOnce();
  });

  it("reuses completed revocation cleanup", async () => {
    revocationMock.getBetaRevocationStatus.mockResolvedValueOnce({
      revocationId: "revocation-complete",
      cleanup: "completed",
    });

    const response = await deleteUser(
      routeContext(deleteRequest(), "target-user"),
    );

    expect(response.status).toBe(200);
    expect(revocationStoreMock.revokeBetaUser).not.toHaveBeenCalled();
    expect(revocationMock.cleanupBetaRevocation).not.toHaveBeenCalled();
    expect(
      deletionStoreMock.finalizePlatformUserDeletion,
    ).toHaveBeenCalledOnce();
  });

  it("does not anonymize the user when operational cleanup fails", async () => {
    revocationStoreMock.revokeBetaUser.mockResolvedValueOnce({
      revocationId: "revocation-failed",
    });
    revocationMock.cleanupBetaRevocation.mockRejectedValueOnce(
      appError(503, "cleanup_failed", "User cleanup failed"),
    );

    const response = await deleteUser(
      routeContext(deleteRequest(), "target-user"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "User cleanup failed",
      code: "cleanup_failed",
    });
    expect(
      deletionStoreMock.finalizePlatformUserDeletion,
    ).not.toHaveBeenCalled();
  });

  it("preserves guarded deletion conflicts", async () => {
    deletionStoreMock.assertPlatformUserDeletionAllowed.mockRejectedValueOnce(
      appError(
        409,
        "last_active_admin",
        "The last active platform administrator cannot be deleted",
      ),
    );

    const response = await deleteUser(
      routeContext(deleteRequest(), "target-user"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The last active platform administrator cannot be deleted",
      code: "last_active_admin",
    });
    expect(revocationStoreMock.revokeBetaUser).not.toHaveBeenCalled();
  });
});

function listRequest(): Request {
  return new Request("https://intar.test/api/admin/users");
}

function deleteRequest(): Request {
  return new Request("https://intar.test/api/admin/users/target-user", {
    method: "DELETE",
  });
}

function roleRequest(body: Record<string, unknown> | string): Request {
  return new Request("https://intar.test/api/admin/users/target-user/role", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function routeContext(request: Request, userId: string) {
  return { request, params: { userId } } as never;
}
