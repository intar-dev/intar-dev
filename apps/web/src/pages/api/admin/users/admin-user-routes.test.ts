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
const detailsStoreMock = vi.hoisted(() => ({
  getPlatformUserDetails: vi.fn(),
}));
const revocationMock = vi.hoisted(() => ({
  ensureAccessRevoked: vi.fn(),
  finishAccessRevocationCleanup: vi.fn(),
  restoreAccess: vi.fn(),
  revokeAccess: vi.fn(),
}));

vi.mock("@/lib/request-security", () => requestSecurityMock);
vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/platform-admin-authority", () => adminAuthorityMock);
vi.mock("@/lib/platform-user-deletion-store", () => deletionStoreMock);
vi.mock("@/lib/access-revocation", () => revocationMock);
vi.mock("@/lib/platform-user-details-store", () => detailsStoreMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { appError } from "@/lib/app-error";
import {
  DELETE as deleteUser,
  GET as getUser,
} from "@/pages/api/admin/users/[userId]/index";
import { POST as restoreRoute } from "@/pages/api/admin/users/[userId]/restore";
import { POST as finishCleanupRoute } from "@/pages/api/admin/users/[userId]/revocation-cleanup";
import { POST as revokeRoute } from "@/pages/api/admin/users/[userId]/revoke";
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
    revocationMock.revokeAccess.mockResolvedValue({
      revocationId: "revocation-1",
    });
    revocationMock.finishAccessRevocationCleanup.mockResolvedValue(undefined);
    revocationMock.restoreAccess.mockResolvedValue({ serversPendingCleanup: 0 });
    detailsStoreMock.getPlatformUserDetails.mockResolvedValue({
      id: "target-user",
      name: "Target User",
    });
  });

  it.each([
    ["list", listUsers, listRequest()],
    ["details", getUser, detailsRequest()],
    ["delete", deleteUser, deleteRequest()],
    ["revoke", revokeRoute, revokeRequest()],
    ["restore", restoreRoute, restoreRequest({ revocationId: "revocation-1" })],
    [
      "revocation cleanup",
      finishCleanupRoute,
      cleanupRequest({ revocationId: "revocation-1" }),
    ],
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
      expect(revocationMock.revokeAccess).not.toHaveBeenCalled();
      expect(revocationMock.restoreAccess).not.toHaveBeenCalled();
      expect(
        revocationMock.finishAccessRevocationCleanup,
      ).not.toHaveBeenCalled();
      expect(
        deletionStoreMock.finalizePlatformUserDeletion,
      ).not.toHaveBeenCalled();
      expect(detailsStoreMock.getPlatformUserDetails).not.toHaveBeenCalled();
    },
  );

  it("passes a refused administrator through with no-store headers", async () => {
    agentBridgeMock.requireAdminUserContext.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });

    const response = await getUser(routeContext(detailsRequest(), "target-user"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(detailsStoreMock.getPlatformUserDetails).not.toHaveBeenCalled();
  });

  it("returns a person's details for the trimmed id", async () => {
    const response = await getUser(
      routeContext(detailsRequest(), " target-user "),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      user: { id: "target-user", name: "Target User" },
    });
    expect(detailsStoreMock.getPlatformUserDetails).toHaveBeenCalledWith(
      "test-db",
      "target-user",
    );
  });

  it("answers a missing or deleted person with 404", async () => {
    detailsStoreMock.getPlatformUserDetails.mockResolvedValueOnce(null);

    const response = await getUser(routeContext(detailsRequest(), "gone"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "User not found",
      code: "user_not_found",
    });
  });

  it("requires a user id and hides unexpected errors", async () => {
    const blank = await getUser(routeContext(detailsRequest(), " "));
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toMatchObject({ code: "user_id_required" });

    detailsStoreMock.getPlatformUserDetails.mockRejectedValueOnce(
      new Error("D1 exploded with secret detail"),
    );
    const failed = await getUser(routeContext(detailsRequest(), "target-user"));
    expect(failed.status).toBe(500);
    const body = await failed.text();
    expect(body).toContain("The user could not be loaded");
    expect(body).not.toContain("secret detail");
  });

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
    const response = await revokeRoute(
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
    expect(revocationMock.revokeAccess).toHaveBeenCalledWith({
      userId: "target-user",
      actorUserId: "actor-admin",
      reason: "admin_revoked",
    });
    expect(revocationMock.ensureAccessRevoked).not.toHaveBeenCalled();
    expect(deletionStoreMock.finalizePlatformUserDeletion).not.toHaveBeenCalled();
  });

  it("refuses an account that is already revoked instead of reusing it", async () => {
    revocationMock.revokeAccess.mockRejectedValueOnce(
      appError(409, "access_already_revoked", "Access is already revoked"),
    );

    const response = await revokeRoute(
      routeContext(revokeRequest({ ignored: true }), "target-user"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Access is already revoked",
      code: "access_already_revoked",
    });
  });

  it("keeps the last active administrator", async () => {
    revocationMock.revokeAccess.mockRejectedValueOnce(
      appError(
        409,
        "last_active_admin",
        "The last active administrator can't be revoked",
      ),
    );

    const response = await revokeRoute(
      routeContext(revokeRequest(), "target-user"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The last active administrator can't be revoked",
      code: "last_active_admin",
    });
  });

  it("reports an unfinished cleanup so it can be retried", async () => {
    revocationMock.revokeAccess.mockRejectedValueOnce(cleanupIncomplete());

    const response = await revokeRoute(
      routeContext(revokeRequest(), "target-user"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "Access is revoked, but cleanup didn't finish. Try again.",
      code: "access_cleanup_incomplete",
    });
  });

  it("finishes the cleanup of the named revocation for the trimmed target", async () => {
    const response = await finishCleanupRoute(
      routeContext(
        cleanupRequest({ revocationId: " revocation-1 " }),
        " target-user ",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      userId: "target-user",
      access: "revoked",
      revocationId: "revocation-1",
      cleanupCompleted: true,
    });
    expect(revocationMock.finishAccessRevocationCleanup).toHaveBeenCalledWith({
      userId: "target-user",
      revocationId: "revocation-1",
      actorUserId: "actor-admin",
    });
    expect(revocationMock.revokeAccess).not.toHaveBeenCalled();
  });

  it("restores access for the trimmed target and revocation", async () => {
    revocationMock.restoreAccess.mockResolvedValueOnce({
      serversPendingCleanup: 1,
    });

    const response = await restoreRoute(
      routeContext(
        restoreRequest({ revocationId: " revocation-1 " }),
        " target-user ",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      userId: "target-user",
      access: "active",
      serversPendingCleanup: 1,
    });
    expect(revocationMock.restoreAccess).toHaveBeenCalledWith({
      userId: "target-user",
      revocationId: "revocation-1",
      actorUserId: "actor-admin",
    });
  });

  it.each([
    ["restore", restoreRoute, restoreRequest],
    ["revocation cleanup", finishCleanupRoute, cleanupRequest],
  ] as const)(
    "requires the %s request to name a revocation",
    async (_name, route, request) => {
      for (const body of ["{", { revocationId: "" }, { revocationId: 7 }, {}]) {
        const response = await route(
          routeContext(request(body), "target-user"),
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe(
          "no-store, max-age=0",
        );
        await expect(response.json()).resolves.toMatchObject({
          code: body === "{" ? "invalid_json" : "revocation_id_required",
        });
      }
      expect(revocationMock.restoreAccess).not.toHaveBeenCalled();
      expect(
        revocationMock.finishAccessRevocationCleanup,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    [403, "admin_required", "An active administrator is required"],
    [404, "user_not_found", "User not found"],
    [409, "access_not_revoked", "Their access isn't revoked"],
    [409, "stale_access_revocation", "The access revocation is no longer current"],
    [409, "access_cleanup_incomplete", "Finish revoking access before restoring it"],
  ] as const)(
    "passes a %s %s restore refusal through",
    async (status, code, message) => {
      revocationMock.restoreAccess.mockRejectedValueOnce(
        appError(status, code, message),
      );

      const response = await restoreRoute(
        routeContext(restoreRequest({ revocationId: "revocation-1" }), "target-user"),
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: message, code });
    },
  );
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

function detailsRequest(): Request {
  return new Request("https://intar.test/api/admin/users/target-user");
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

function restoreRequest(body: Record<string, unknown> | string): Request {
  return jsonPost("restore", body);
}

function cleanupRequest(body: Record<string, unknown> | string): Request {
  return jsonPost("revocation-cleanup", body);
}

function jsonPost(path: string, body: Record<string, unknown> | string): Request {
  return new Request(`https://intar.test/api/admin/users/target-user/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
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
