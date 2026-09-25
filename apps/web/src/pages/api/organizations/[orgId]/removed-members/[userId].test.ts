import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  userContext: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: mocks.userContext,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
vi.mock("@/lib/organizations", () => ({
  restoreOrganizationMember: mocks.restore,
}));

import { DELETE } from "./[userId]";

describe("restore removed member route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin" },
    });
    mocks.restore.mockResolvedValue(undefined);
  });

  it("restores the person for the acting admin", async () => {
    const response = await DELETE(context());
    expect(response.status).toBe(204);
    expect(mocks.restore).toHaveBeenCalledWith({
      organizationId: "organization",
      userId: "removed-user",
      actorUserId: "admin",
    });
  });

  it("reports a person who was not removed", async () => {
    mocks.restore.mockRejectedValue(
      appError(404, "removed_member_not_found", "removed member not found"),
    );
    const response = await DELETE(context());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "removed_member_not_found",
    });
  });
});

function context(): APIContext {
  return {
    params: { orgId: "organization", userId: "removed-user" },
    request: new Request(
      "https://intar.dev/api/organizations/organization/removed-members/removed-user",
      { method: "DELETE" },
    ),
  } as unknown as APIContext;
}
