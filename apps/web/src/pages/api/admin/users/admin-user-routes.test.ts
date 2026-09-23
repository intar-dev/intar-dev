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
const adminAuthorityMock = vi.hoisted(() => ({
  setPlatformUserRole: vi.fn(),
}));
const deletionStoreMock = vi.hoisted(() => ({
  assertPlatformUserDeletionAllowed: vi.fn(),
  finalizePlatformUserDeletion: vi.fn(),
  listPlatformUsers: vi.fn(),
}));
const revocationMock = vi.hoisted(() => ({
  ensureAccessRevoked: vi.fn(),
}));

vi.mock("@/lib/request-security", () => requestSecurityMock);
vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/platform-admin-authority", () => adminAuthorityMock);
vi.mock("@/lib/platform-user-deletion-store", () => deletionStoreMock);
vi.mock("@/lib/access-revocation", () => revocationMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { appError } from "@/lib/app-error";
import { DELETE as deleteUser } from "@/pages/api/admin/users/[userId]/index";
import { POST as revokeAccess } from "@/pages/api/admin/users/[userId]/revoke";
import { POST as updateRole } from "@/pages/api/admin/users/[userId]/role";
import { GET as listUsers } from "@/pages/api/admin/users/index";

describe("admin user mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "actor-admin" },
    });
    adminAuthorityMock.setPlatformUserRole.mockResolvedValue(undefined);
    deletionStoreMock.assertPlatformUserDeletionAllowed.mockResolvedValue(
      undefined,
    );
    deletionStoreMock.finalizePlatformUserDeletion.mockResolvedValue(undefined);
    deletionStoreMock.listPlatformUsers.mockResolvedValue([
      { id: "target-user", name: "Target User" },
    ]);
    revocationMock.ensureAccessRevoked.mockResolvedValue({
      revocationId: "revocation-1",
    });
  });

  it.each([
    ["list", listUsers, listRequest()],
    ["delete", deleteUser, deleteRequest()],
    ["revoke", revokeAccess, revokeRequest()],
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
      expect(revocationMock.ensureAccessRevoked).not.toHaveBeenCalled();
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
    expect(adminAuthorityMock.setPlatformUserRole).not.toHaveBeenCalled();
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
    expect(adminAuthorityMock.setPlatformUserRole).toHaveBeenCalledWith({
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
      role: "admin",
    });
  });

  it("revokes access and finishes the cleanup before deletion", async () => {
    const response = await deleteUser(
      routeContext(deleteRequest(), " target-user "),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    const target = {
      d1: "test-db",
      targetUserId: "target-user",
      actorUserId: "actor-admin",
    };
    expect(
      deletionStoreMock.assertPlatformUserDeletionAllowed,
    ).toHaveBeenCalledWith(target);
    expect(revocationMock.ensureAccessRevoked).toHaveBeenCalledWith({
      userId: "target-user",
      actorUserId: "actor-admin",
      reason: "admin_deleted",
    });
    expect(deletionStoreMock.finalizePlatformUserDeletion).toHaveBeenCalledWith(
      target,
    );
    expect(
      revocationMock.ensureAccessRevoked.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      deletionStoreMock.assertPlatformUserDeletionAllowed.mock
        .invocationCallOrder[0]!,
    );
    expect(
      deletionStoreMock.finalizePlatformUserDeletion.mock.invocationCallOrder[0],
    ).toBeGreaterThan(revocationMock.ensureAccessRevoked.mock.invocationCallOrder[0]!);
  });

  it("does not anonymize the user when the cleanup is incomplete", async () => {
    revocationMock.ensureAccessRevoked.mockRejectedValueOnce(cleanupIncomplete());

    const response = await deleteUser(
      routeContext(deleteRequest(), "target-user"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Access is revoked, but cleanup didn't finish. Try again.",
      code: "access_cleanup_incomplete",
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
        "The last active administrator can't be deleted",
      ),
    );

    const response = await deleteUser(
      routeContext(deleteRequest(), "target-user"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The last active administrator can't be deleted",
      code: "last_active_admin",
    });
    expect(revocationMock.ensureAccessRevoked).not.toHaveBeenCalled();
  });

  it("revokes access and cleans up for the trimmed target", async () => {
    const response = await revokeAccess(
      routeContext(revokeRequest(), " target-user "),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      userId: "target-user",
      access: "revoked",
      revocationId: "revocation-1",
      cleanupCompleted: true,
    });
    expect(revocationMock.ensureAccessRevoked).toHaveBeenCalledWith({
      userId: "target-user",
      actorUserId: "actor-admin",
      reason: "admin_revoked",
    });
    expect(deletionStoreMock.finalizePlatformUserDeletion).not.toHaveBeenCalled();
  });

  it("answers a finished revocation with its existing id", async () => {
    revocationMock.ensureAccessRevoked.mockResolvedValueOnce({
      revocationId: "revocation-complete",
    });

    const response = await revokeAccess(
      routeContext(revokeRequest({ ignored: true }), "target-user"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revocationId: "revocation-complete",
      cleanupCompleted: true,
    });
    expect(revocationMock.ensureAccessRevoked).toHaveBeenCalledOnce();
  });

  it("keeps the last active administrator", async () => {
    revocationMock.ensureAccessRevoked.mockRejectedValueOnce(
      appError(
        409,
        "last_active_admin",
        "The last active administrator can't be revoked",
      ),
    );

    const response = await revokeAccess(
      routeContext(revokeRequest(), "target-user"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The last active administrator can't be revoked",
      code: "last_active_admin",
    });
  });

  it("reports an unfinished cleanup so it can be retried", async () => {
    revocationMock.ensureAccessRevoked.mockRejectedValueOnce(cleanupIncomplete());

    const response = await revokeAccess(
      routeContext(revokeRequest(), "target-user"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "Access is revoked, but cleanup didn't finish. Try again.",
      code: "access_cleanup_incomplete",
    });
  });
});

function cleanupIncomplete() {
  return appError(
    503,
    "access_cleanup_incomplete",
    "Access is revoked, but cleanup didn't finish. Try again.",
  );
}

function listRequest(): Request {
  return new Request("https://intar.test/api/admin/users");
}

function deleteRequest(): Request {
  return new Request("https://intar.test/api/admin/users/target-user", {
    method: "DELETE",
  });
}

function revokeRequest(body?: Record<string, unknown>): Request {
  return new Request("https://intar.test/api/admin/users/target-user/revoke", {
    method: "POST",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
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
