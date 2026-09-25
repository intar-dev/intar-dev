import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminContext: vi.fn(),
  resolveOrganizationId: vi.fn(),
  list: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  requireAdminUserContext: mocks.adminContext,
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: mocks.resolveOrganizationId,
  listOrganizationRemovedMembers: mocks.list,
  restoreRemovedMemberAsPlatformAdmin: mocks.restore,
}));
vi.mock("@/lib/request-security", () => ({
  NO_STORE_HEADERS: { "cache-control": "no-store" },
}));

import { GET } from "./index";
import { DELETE } from "./[userId]";

describe("platform admin removed-member routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminContext.mockResolvedValue({
      ok: true,
      context: { userId: "platform-admin" },
    });
    mocks.resolveOrganizationId.mockResolvedValue("organization");
    mocks.list.mockResolvedValue([{ userId: "removed", removedAt: 1 }]);
    mocks.restore.mockResolvedValue(undefined);
  });

  it("lists removed people without membership", async () => {
    const response = await GET(context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removedMembers: [{ userId: "removed", removedAt: 1 }],
    });
    expect(mocks.list).toHaveBeenCalledWith("organization");
  });

  it("restores as the platform admin", async () => {
    const response = await DELETE(context({ userId: "removed" }));
    expect(response.status).toBe(204);
    expect(mocks.restore).toHaveBeenCalledWith({
      organizationId: "organization",
      userId: "removed",
      actorUserId: "platform-admin",
    });
  });

  it("returns the admin guard's refusal to everyone else", async () => {
    mocks.adminContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });
    expect((await GET(context())).status).toBe(403);
    expect((await DELETE(context({ userId: "removed" }))).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("answers an unknown organization with 404", async () => {
    mocks.resolveOrganizationId.mockResolvedValue(null);
    const response = await DELETE(context({ userId: "removed" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "organization_not_found",
    });
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});

function context(params: Record<string, string> = {}): APIContext {
  return {
    params: { orgId: "organization", ...params },
    request: new Request(
      "https://intar.dev/api/admin/organizations/organization/removed-members",
    ),
  } as unknown as APIContext;
}
