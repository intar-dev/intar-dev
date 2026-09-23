import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appBootstrapQueryKey,
  appBootstrapQueryOptions,
  appQueryClient,
  getClientAppBootstrap,
  parseAppBootstrapData,
} from "./app-bootstrap";
import { sessionQueryOptions } from "@/components/app/hooks/useSession";

afterEach(() => {
  appQueryClient.clear();
  vi.unstubAllGlobals();
});

describe("app bootstrap client", () => {
  it("uses one private no-store request and returns the bootstrap data", async () => {
    const session = {
      session: { id: "session-1" },
      user: { id: "user-1", email: "learner@example.test" },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ session, access: "active" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getClientAppBootstrap()).resolves.toEqual({
      session,
      access: "active",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/app/bootstrap", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("fails closed for malformed bootstrap data", () => {
    expect(parseAppBootstrapData({ access: "active" })).toEqual({
      session: null,
      access: "inactive",
    });
    expect(
      parseAppBootstrapData({
        session: { session: { id: 1 }, user: { id: "user-1" } },
        access: "unexpected",
      }),
    ).toEqual({ session: null, access: "inactive" });
    expect(
      parseAppBootstrapData({
        session: { session: { id: "session-1" }, user: { id: "user-1" } },
        access: "unexpected",
      }),
    ).toMatchObject({ access: "inactive" });
  });

  it("rejects an unavailable bootstrap endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(getClientAppBootstrap()).rejects.toThrow(
      "Failed to load app bootstrap state",
    );
  });

  it("shares one fresh bootstrap cache entry across route guards and useSession", async () => {
    const bootstrap = {
      session: {
        session: { id: "session-1" },
        user: { id: "user-1" },
      },
      access: "active",
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(bootstrap), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      appQueryClient.fetchQuery(appBootstrapQueryOptions()),
      appQueryClient.fetchQuery(appBootstrapQueryOptions()),
    ]);
    const sessionObserver = new QueryObserver(
      appQueryClient,
      sessionQueryOptions(),
    );
    const unsubscribe = sessionObserver.subscribe(() => undefined);

    expect(first).toEqual(bootstrap);
    expect(second).toEqual(bootstrap);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appQueryClient.getQueryData(appBootstrapQueryKey)).toEqual(bootstrap);
    expect(sessionObserver.getCurrentResult().data).toEqual(bootstrap.session);
    unsubscribe();
  });
});
