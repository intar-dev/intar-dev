import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  requireAdminUserContext: vi.fn(),
}));
const signupsMock = vi.hoisted(() => ({
  getSignupStatus: vi.fn(),
  setSignupLimit: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/signups", () => signupsMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { appError } from "@/lib/app-error";
import { GET, PUT } from "./signups";

const adminStatus = {
  limit: 50,
  taken: 38,
  remaining: 12,
  open: true,
  version: 3,
  updatedAt: 1_700_000_000_000,
};

describe("admin sign-up limit API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "actor-admin" },
    });
    signupsMock.getSignupStatus.mockResolvedValue(adminStatus);
    signupsMock.setSignupLimit.mockResolvedValue({
      ...adminStatus,
      limit: 60,
      remaining: 22,
      version: 4,
    });
  });

  it.each([
    [401, "authentication_required"],
    [403, "admin_required"],
  ] as const)(
    "refuses a %i caller for both methods with no-store headers",
    async (status, code) => {
      for (const route of [
        () => GET(routeContext(getRequest())),
        () => PUT(routeContext(putRequest({ limit: 60, expectedVersion: 3 }))),
      ]) {
        agentBridgeMock.requireAdminUserContext.mockResolvedValueOnce({
          ok: false,
          response: Response.json({ error: "refused", code }, { status }),
        });

        const response = await route();

        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe(
          "no-store, max-age=0",
        );
        await expect(response.json()).resolves.toEqual({
          error: "refused",
          code,
        });
      }
      expect(signupsMock.getSignupStatus).not.toHaveBeenCalled();
      expect(signupsMock.setSignupLimit).not.toHaveBeenCalled();
    },
  );

  it("returns the limit with its version", async () => {
    const response = await GET(routeContext(getRequest()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual(adminStatus);
    expect(signupsMock.getSignupStatus).toHaveBeenCalledWith("test-db");
  });

  it("saves the limit for the authenticated administrator", async () => {
    const response = await PUT(
      routeContext(putRequest({ limit: 60, expectedVersion: 3 })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toMatchObject({
      limit: 60,
      version: 4,
    });
    expect(signupsMock.setSignupLimit).toHaveBeenCalledWith({
      d1: "test-db",
      actorUserId: "actor-admin",
      limit: 60,
      expectedVersion: 3,
    });
  });

  it("rejects a body that is not a JSON object", async () => {
    for (const body of ["{", "[60]"]) {
      const response = await PUT(routeContext(putRequest(body)));

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
      await expect(response.json()).resolves.toEqual({
        error: "a JSON object is required",
        code: "invalid_json",
      });
    }
    expect(signupsMock.setSignupLimit).not.toHaveBeenCalled();
  });

  it.each([
    [
      { limit: 1_000_001, expectedVersion: 3 },
      appError(
        400,
        "signup_limit_invalid",
        "The sign-up limit must be a whole number from 0 to 1,000,000",
      ),
    ],
    [
      { limit: 60, expectedVersion: "3" },
      appError(
        400,
        "signup_version_invalid",
        "The expected sign-up limit version is invalid",
      ),
    ],
  ])("passes invalid input to the store and returns its 400: %j", async (body, error) => {
    signupsMock.setSignupLimit.mockRejectedValueOnce(error);

    const response = await PUT(routeContext(putRequest(body)));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: error.message,
      code: error.code,
    });
    expect(signupsMock.setSignupLimit).toHaveBeenCalledWith({
      d1: "test-db",
      actorUserId: "actor-admin",
      ...body,
    });
  });

  it("returns 409 for a stale version", async () => {
    signupsMock.setSignupLimit.mockRejectedValueOnce(
      appError(
        409,
        "signups_stale_version",
        "The limit changed in another session. Review it and save again.",
      ),
    );

    const response = await PUT(
      routeContext(putRequest({ limit: 60, expectedVersion: 2 })),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "The limit changed in another session. Review it and save again.",
      code: "signups_stale_version",
    });
  });
});

function getRequest(): Request {
  return new Request("https://intar.test/api/admin/signups");
}

function putRequest(body: Record<string, unknown> | string): Request {
  return new Request("https://intar.test/api/admin/signups", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function routeContext(request: Request) {
  return { request } as never;
}
