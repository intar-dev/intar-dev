/// <reference types="@cloudflare/vitest-plugin/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const accountAccessMock = vi.hoisted(() => ({
  sessionMayAct: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: authMock.getSession } },
}));
vi.mock("@/lib/account-access", () => ({
  sessionMayAct: accountAccessMock.sessionMayAct,
}));
const flagsMock = vi.hoisted(() => ({ getBoolean: vi.fn() }));
vi.mock("@/lib/organization-access", () => ({
  featureToggleService: () => ({ getBoolean: flagsMock.getBoolean }),
}));

import { GET } from "./bootstrap";

describe("app bootstrap API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getSession.mockResolvedValue(null);
    accountAccessMock.sessionMayAct.mockResolvedValue(false);
    flagsMock.getBoolean.mockResolvedValue(true);
  });

  it("returns a private inactive bootstrap for an anonymous visitor", async () => {
    const request = new Request("https://intar.test/api/app/bootstrap");

    const response = await GET({ request } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({
      session: null,
      access: "inactive",
      builderOperations: false,
    });
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
    expect(authMock.getSession).toHaveBeenCalledWith({
      headers: request.headers,
    });
    expect(accountAccessMock.sessionMayAct).not.toHaveBeenCalled();
  });

  it("returns the session and active access after one session lookup", async () => {
    const authSession = {
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "learner@example.test" },
    };
    authMock.getSession.mockResolvedValue(authSession);
    accountAccessMock.sessionMayAct.mockResolvedValue(true);

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: authSession,
      access: "active",
      // Not an administrator: the flag is not even asked.
      builderOperations: false,
    });
    expect(flagsMock.getBoolean).not.toHaveBeenCalled();
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
    // The session rule every API request applies, impersonation included.
    expect(accountAccessMock.sessionMayAct).toHaveBeenCalledWith(
      authSession.session,
    );
  });

  it("reports inactive access for an account that can no longer sign in", async () => {
    authMock.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
    accountAccessMock.sessionMayAct.mockResolvedValue(false);

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access: "inactive",
    });
  });

  it("fails closed for a malformed auth result", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "user-1" } });

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: null,
      access: "inactive",
      builderOperations: false,
    });
    expect(accountAccessMock.sessionMayAct).not.toHaveBeenCalled();
  });

  it("does not admit a user when bootstrap loading fails", async () => {
    authMock.getSession.mockRejectedValue(new Error("database unavailable"));

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "The app bootstrap state could not be loaded",
    });
  });

  it("does not admit a user when the account state cannot be loaded", async () => {
    authMock.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
    accountAccessMock.sessionMayAct.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "The app bootstrap state could not be loaded",
    });
  });

  it("tells an acting platform administrator whether the builder's surfaces are shown", async () => {
    const admin = {
      session: { id: "session-1", userId: "admin-1" },
      user: { id: "admin-1", email: "admin@example.test", role: "admin" },
    };
    authMock.getSession.mockResolvedValue(admin);
    const read = async () =>
      ((await (await GET({ request: new Request("https://intar.test/api/app/bootstrap") } as never)).json()) as {
        builderOperations: boolean;
      }).builderOperations;

    accountAccessMock.sessionMayAct.mockResolvedValue(true);
    expect(await read()).toBe(true);
    expect(flagsMock.getBoolean).toHaveBeenCalledWith("builder_operations", false, { targetingKey: "admin-1" });
    flagsMock.getBoolean.mockResolvedValue(false);
    expect(await read()).toBe(false);
    // An administrator whose session may not act is told nothing.
    flagsMock.getBoolean.mockResolvedValue(true);
    accountAccessMock.sessionMayAct.mockResolvedValue(false);
    expect(await read()).toBe(false);
  });
});
