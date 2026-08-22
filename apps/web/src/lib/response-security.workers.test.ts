/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { hardenWorkerResponse, responseSecurity } from "./response-security";

const productionEnv = {
  BETTER_AUTH_URL: "https://intar.dev",
} as Pick<Cloudflare.Env, "BETTER_AUTH_URL">;

describe("worker response security", () => {
  it("adds the common policy headers and production HSTS", () => {
    const response = hardenWorkerResponse(
      new Request("https://intar.dev/courses"),
      new Response("ok"),
      productionEnv,
    );

    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toBe(
      responseSecurity.DEFAULT_PERMISSIONS_POLICY,
    );
    expect(response.headers.get("content-security-policy")).toBe(
      responseSecurity.DEFAULT_CONTENT_SECURITY_POLICY,
    );
  });

  it("does not set HSTS outside the production HTTPS origin", () => {
    const local = hardenWorkerResponse(
      new Request("http://localhost/api/scenarios"),
      new Response("{}"),
      {
        BETTER_AUTH_URL: "http://localhost",
      } as unknown as Pick<Cloudflare.Env, "BETTER_AUTH_URL">,
    );
    const preview = hardenWorkerResponse(
      new Request("https://preview.intar.dev/api/scenarios"),
      new Response("{}"),
      productionEnv,
    );

    expect(local.headers.get("strict-transport-security")).toBeNull();
    expect(preview.headers.get("strict-transport-security")).toBeNull();
  });

  it("makes every API response private and no-store", () => {
    const response = hardenWorkerResponse(
      new Request("https://intar.dev/api/scenarios"),
      new Response("{}", {
        headers: { "cache-control": "public, max-age=3600" },
      }),
      productionEnv,
    );

    expect(response.headers.get("cache-control")).toBe(
      responseSecurity.API_CACHE_CONTROL,
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("retains route-specific stricter content and permissions policies", () => {
    const response = hardenWorkerResponse(
      new Request("https://intar.dev/join"),
      new Response("ok", {
        headers: {
          "content-security-policy": "default-src 'none'; script-src 'none'",
          "permissions-policy": "camera=()",
        },
      }),
      productionEnv,
    );

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'none'",
    );
    expect(response.headers.get("permissions-policy")).toBe("camera=()");
  });

  it("hardens a normal Response that has no Worker WebSocket property", () => {
    const response = hardenWorkerResponse(
      new Request("https://intar.dev/"),
      new Response("ok"),
      productionEnv,
    );

    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
