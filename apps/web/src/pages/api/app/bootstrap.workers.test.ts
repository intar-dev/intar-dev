/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const accountAccessMock = vi.hoisted(() => ({
  isActiveAccount: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: authMock.getSession } },
}));
vi.mock("@/lib/account-access", () => ({
  isActiveAccount: accountAccessMock.isActiveAccount,
}));

import { GET } from "./bootstrap";

describe("app bootstrap API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getSession.mockResolvedValue(null);
    accountAccessMock.isActiveAccount.mockResolvedValue(false);
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
    });
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
    expect(authMock.getSession).toHaveBeenCalledWith({
      headers: request.headers,
    });
    expect(accountAccessMock.isActiveAccount).not.toHaveBeenCalled();
  });

  it("returns the session and active access after one session lookup", async () => {
    const authSession = {
      session: { id: "session-1" },
      user: { id: "user-1", email: "learner@example.test" },
    };
    authMock.getSession.mockResolvedValue(authSession);
    accountAccessMock.isActiveAccount.mockResolvedValue(true);

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: authSession,
      access: "active",
    });
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
    expect(accountAccessMock.isActiveAccount).toHaveBeenCalledWith("user-1");
  });

  it("reports an inactive account for a revoked or deleted user", async () => {
    authMock.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
    accountAccessMock.isActiveAccount.mockResolvedValue(false);

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
    });
    expect(accountAccessMock.isActiveAccount).not.toHaveBeenCalled();
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
    accountAccessMock.isActiveAccount.mockRejectedValue(
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
});
