import { beforeEach, describe, expect, it, vi } from "vitest";

const signupsMock = vi.hoisted(() => ({
  getSignupStatus: vi.fn(),
}));

vi.mock("@/lib/signups", () => signupsMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));

import { GET } from "./signups";

describe("public sign-up status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signupsMock.getSignupStatus.mockResolvedValue({
      limit: 50,
      taken: 38,
      remaining: 12,
      open: true,
      version: 3,
      updatedAt: 1_700_000_000_000,
    });
  });

  it("returns only the public counts with no-store headers", async () => {
    const response = await GET({} as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({
      limit: 50,
      taken: 38,
      remaining: 12,
      open: true,
    });
    expect(signupsMock.getSignupStatus).toHaveBeenCalledWith("test-db");
  });

  it("reports closed sign-ups when no limit is saved", async () => {
    signupsMock.getSignupStatus.mockResolvedValue({
      limit: 0,
      taken: 4,
      remaining: 0,
      open: false,
      version: 0,
      updatedAt: null,
    });

    const response = await GET({} as never);

    await expect(response.json()).resolves.toEqual({
      limit: 0,
      taken: 4,
      remaining: 0,
      open: false,
    });
  });

  it("fails without detail when the counts cannot be read", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    signupsMock.getSignupStatus.mockRejectedValue(new Error("D1 unavailable"));

    const response = await GET({} as never);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "The sign-up status could not be loaded",
    });
    consoleError.mockRestore();
  });
});
