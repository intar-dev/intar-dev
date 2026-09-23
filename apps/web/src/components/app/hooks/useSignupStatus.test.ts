import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSignupStatus,
  SIGNUP_STATUS_STALE_TIME_MS,
  signupStatusEnabled,
  signupStatusQueryKey,
  signupStatusQueryOptions,
} from "./useSignupStatus";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-up status query", () => {
  it("loads the public counts with one no-store request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ limit: 50, taken: 38, remaining: 12, open: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSignupStatus()).resolves.toEqual({
      limit: 50,
      taken: 38,
      remaining: 12,
      open: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/signups", {
      method: "GET",
      cache: "no-store",
      signal: null,
    });
  });

  it("derives the spots from the limit and the count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ limit: 50, taken: 62, remaining: 7, open: true }),
      ),
    );

    await expect(fetchSignupStatus()).resolves.toEqual({
      limit: 50,
      taken: 62,
      remaining: 0,
      open: false,
    });
  });

  it("rejects an unavailable endpoint and malformed counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(fetchSignupStatus()).rejects.toThrow(
      "Failed to load sign-up spots (503)",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ limit: -1, taken: 0 })),
    );
    await expect(fetchSignupStatus()).rejects.toThrow(
      "The sign-up status response is invalid",
    );
  });

  it("caches under one key for 30 seconds with one retry", () => {
    expect(signupStatusQueryOptions({ enabled: true })).toMatchObject({
      queryKey: ["signups", "status"],
      staleTime: 30_000,
      retry: 1,
      enabled: true,
    });
    expect(signupStatusQueryKey).toEqual(["signups", "status"]);
    expect(SIGNUP_STATUS_STALE_TIME_MS).toBe(30_000);
  });

  it("waits for the session and skips signed-in visitors", () => {
    expect(signupStatusEnabled({ isSuccess: false, data: undefined })).toBe(
      false,
    );
    expect(
      signupStatusEnabled({ isSuccess: true, data: { user: { id: "user-1" } } }),
    ).toBe(false);
    expect(signupStatusEnabled({ isSuccess: true, data: null })).toBe(true);
  });

  it("does not fetch while disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ limit: 50, taken: 38 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();

    const disabled = new QueryObserver(
      client,
      signupStatusQueryOptions({ enabled: false }),
    );
    const unsubscribe = disabled.subscribe(() => undefined);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();

    await expect(
      client.fetchQuery(signupStatusQueryOptions({ enabled: true })),
    ).resolves.toMatchObject({ remaining: 12, open: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    client.clear();
  });
});
