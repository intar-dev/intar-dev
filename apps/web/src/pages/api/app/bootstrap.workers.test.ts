/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const betaAccessMock = vi.hoisted(() => ({
  getBetaAccessState: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: authMock.getSession } },
}));
vi.mock("@/lib/allowlist", () => ({
  getBetaAccessState: betaAccessMock.getBetaAccessState,
}));

import { GET } from "./bootstrap";

describe("app bootstrap API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getSession.mockResolvedValue(null);
    betaAccessMock.getBetaAccessState.mockResolvedValue(null);
  });

  it("returns a private restricted bootstrap for an anonymous visitor", async () => {
    const request = new Request("https://intar.test/api/app/bootstrap");

    const response = await GET({ request } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({
      session: null,
      betaAccess: "restricted",
    });
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
    expect(authMock.getSession).toHaveBeenCalledWith({
      headers: request.headers,
    });
    expect(betaAccessMock.getBetaAccessState).not.toHaveBeenCalled();
  });

  it("returns the session and active access after one session lookup", async () => {
    const authSession = {
      session: { id: "session-1" },
      user: { id: "user-1", email: "learner@example.test" },
    };
    authMock.getSession.mockResolvedValue(authSession);
    betaAccessMock.getBetaAccessState.mockResolvedValue("active");

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: authSession,
      betaAccess: "active",
    });
    expect(authMock.getSession).toHaveBeenCalledTimes(1);
    expect(betaAccessMock.getBetaAccessState).toHaveBeenCalledWith("user-1");
  });

  it("fails closed when the beta admission is not active", async () => {
    authMock.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
    betaAccessMock.getBetaAccessState.mockResolvedValue("blocked");

    const response = await GET({
      request: new Request("https://intar.test/api/app/bootstrap"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      betaAccess: "restricted",
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
      betaAccess: "restricted",
    });
    expect(betaAccessMock.getBetaAccessState).not.toHaveBeenCalled();
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

  it("does not admit a user when beta access loading fails", async () => {
    authMock.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
    betaAccessMock.getBetaAccessState.mockRejectedValue(
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
