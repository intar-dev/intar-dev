/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";
import {
  MAX_API_JSON_BODY_BYTES,
  clientNetwork,
  enforceRateLimit,
  guardBetterAuthRequest,
  guardCanonicalRequestPath,
  guardCustomApiMutation,
  secureApplicationApiRequest,
  sensitiveRateLimitActionFor,
} from "./request-security";

function securityEnv(
  limit: (input: {
    key: string;
  }) => Promise<{ success: boolean }> = async () => ({
    success: true,
  }),
) {
  return {
    BETTER_AUTH_URL: "https://intar.dev",
    ACCESS_INVITE_RATE_LIMITER: { limit },
  } as Pick<Cloudflare.Env, "ACCESS_INVITE_RATE_LIMITER" | "BETTER_AUTH_URL">;
}

function customMutation(pathname: string, init: RequestInit = {}): Request {
  const headers = new Headers({
    origin: "https://intar.dev",
    "sec-fetch-site": "same-origin",
  });
  for (const [name, value] of new Headers(init.headers)) {
    headers.set(name, value);
  }
  return new Request(`https://intar.dev${pathname}`, {
    ...init,
    method: init.method ?? "POST",
    headers,
  });
}

async function responseBody(
  result: Awaited<ReturnType<typeof guardCustomApiMutation>>,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected request rejection");
  return result.response.json() as Promise<{ error: string; code: string }>;
}

const BODYLESS_CUSTOM_MUTATIONS = [
  ["DELETE", "/api/admin/runs/run-1"],
  ["POST", "/api/admin/builds/build-1/retry"],
  ["POST", "/api/admin/scenarios/demo/enabled"],
  ["DELETE", "/api/admin/scenarios/demo/enabled"],
  ["DELETE", "/api/agent/hosts/host-1"],
  ["DELETE", "/api/organizations/org/assignments/assignment-1"],
  ["DELETE", "/api/organizations/org"],
  ["POST", "/api/organizations/org/leave"],
  ["DELETE", "/api/organizations/org/members/member-1"],
  ["DELETE", "/api/organizations/org/scenarios/demo"],
  ["DELETE", "/api/organizations/org/sso"],
  ["POST", "/api/organizations/org/sso/verification"],
  ["POST", "/api/organizations/org/sso/verify"],
  ["DELETE", "/api/profile/ssh-keys/key-1"],
  ["DELETE", "/api/scenarios/runs/run-1"],
  ["POST", "/api/scenarios/runs/run-1/destroy"],
  ["POST", "/api/scenarios/runs/run-1/solution/reveal"],
] as const;

describe("worker API request security", () => {
  it("rejects encoded paths before Astro can decode them into protected routes", async () => {
    for (const pathname of [
      "/%61pi/scenarios/demo/start",
      "/api/%61uth/sign-in/social",
      "/api/auth/sso/%73aml2/callback/provider",
      "/%61gent/connect",
      "/api/runs/run-1/artifacts/vm-1%3A0/content",
    ]) {
      const result = guardCanonicalRequestPath(
        new Request(`https://intar.dev${pathname}`, { method: "POST" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected encoded path rejection");
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("cache-control")).toContain(
        "no-store",
      );
      await expect(result.response.json()).resolves.toMatchObject({
        code: "encoded_path_not_allowed",
      });
    }
  });

  it("accepts canonical literal colons in server-minted resource IDs", () => {
    const result = guardCanonicalRequestPath(
      new Request(
        "https://intar.dev/api/runs/run-1/artifacts/vm-1:0/content",
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts exact-origin bodyless custom mutations", async () => {
    const nullBodyRequest = customMutation("/api/scenarios/demo/start", {
      headers: {
        "content-length": "0",
        "content-type": "application/json",
      },
    });
    const nullBody = await secureApplicationApiRequest(
      nullBodyRequest,
      securityEnv(),
    );
    expect(nullBody.ok).toBe(true);
    if (!nullBody.ok) return;
    expect(nullBody.request.body).toBeNull();
    expect(nullBody.request.headers.get("content-length")).toBeNull();
    expect(nullBody.request.headers.get("content-type")).toBeNull();

    const streamedEmptyRequest = customMutation(
      "/api/scenarios/demo/start",
      {
        headers: {
          "content-length": "0",
          "content-type": "application/json",
        },
        body: new Uint8Array(),
      },
    );
    expect(streamedEmptyRequest.body).not.toBeNull();
    const streamedEmpty = await secureApplicationApiRequest(
      streamedEmptyRequest,
      securityEnv(),
    );
    expect(streamedEmpty.ok).toBe(true);
    if (!streamedEmpty.ok) return;
    expect(streamedEmpty.request.body).toBeNull();
    expect(streamedEmpty.request.headers.get("content-length")).toBeNull();
    expect(streamedEmpty.request.headers.get("content-type")).toBeNull();
  });

  it.each(BODYLESS_CUSTOM_MUTATIONS)(
    "accepts streamed-empty %s %s",
    async (method, pathname) => {
      const result = await guardCustomApiMutation(
        customMutation(pathname, { method, body: new Uint8Array() }),
        securityEnv(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request.body).toBeNull();
      expect(result.request.headers.get("content-type")).toBeNull();
    },
  );

  it("rate-limits sensitive requests before reading their bodies", async () => {
    const request = customMutation("/api/scenarios/demo/start", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1024 * 1024 - 32) }),
    });
    if (!request.body) throw new Error("expected request body");
    const getReader = vi.spyOn(request.body, "getReader");

    const result = await secureApplicationApiRequest(
      request,
      securityEnv(async () => ({ success: false })),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("accepts absent fetch metadata but rejects missing, sibling, and cross-site origins", async () => {
    const missingMetadata = await guardCustomApiMutation(
      new Request("https://intar.dev/api/scenarios/demo/start", {
        method: "POST",
        headers: { origin: "https://intar.dev" },
      }),
      securityEnv(),
    );
    expect(missingMetadata.ok).toBe(true);

    const rejectedRequests = [
      [
        new Request("https://intar.dev/api/scenarios/demo/start", {
          method: "POST",
        }),
        "invalid_origin",
      ],
      [
        customMutation("/api/scenarios/demo/start", {
          headers: { origin: "https://admin.intar.dev" },
        }),
        "invalid_origin",
      ],
      [
        customMutation("/api/scenarios/demo/start", {
          headers: { origin: "https://intar.dev/" },
        }),
        "invalid_origin",
      ],
      [
        customMutation("/api/scenarios/demo/start", {
          headers: { "sec-fetch-site": "same-site" },
        }),
        "cross_site_request",
      ],
      [
        customMutation("/api/scenarios/demo/start", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
        "cross_site_request",
      ],
    ] as const;
    for (const [request, code] of rejectedRequests) {
      const result = await guardCustomApiMutation(request, securityEnv());
      await expect(responseBody(result)).resolves.toMatchObject({ code });
    }
  });

  it("bounds actual JSON bytes and gives Astro a readable rebuilt request", async () => {
    const oversizedBody = JSON.stringify({
      payload: "x".repeat(MAX_API_JSON_BODY_BYTES),
    });
    const oversized = await guardCustomApiMutation(
      customMutation("/api/scenarios/demo/start", {
        headers: { "content-type": "application/json" },
        body: oversizedBody,
      }),
      securityEnv(),
    );
    await expect(responseBody(oversized)).resolves.toMatchObject({
      code: "request_too_large",
    });

    const body = JSON.stringify({ hostId: "host-1" });
    const allowed = await guardCustomApiMutation(
      customMutation("/api/scenarios/demo/start", {
        headers: { "content-type": "application/json" },
        body,
      }),
      securityEnv(),
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.request).not.toBeInstanceOf(Response);
    expect(await allowed.request.text()).toBe(body);
    expect(allowed.request.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(body).byteLength),
    );

    const jsonp = await guardCustomApiMutation(
      customMutation("/api/scenarios/demo/start", {
        headers: { "content-type": "application/jsonp" },
        body: "{}",
      }),
      securityEnv(),
    );
    await expect(responseBody(jsonp)).resolves.toMatchObject({
      code: "json_required",
    });
  });

  it("rejects declared and actual body-length mismatches", async () => {
    for (const [declaredLength, body] of [
      ["1", new Uint8Array()],
      ["0", "{}"],
    ] as const) {
      const custom = await guardCustomApiMutation(
        customMutation("/api/scenarios/demo/start", {
          headers: {
            "content-length": declaredLength,
            "content-type": "application/json",
          },
          body,
        }),
        securityEnv(),
      );
      await expect(responseBody(custom)).resolves.toMatchObject({
        code: "content_length_mismatch",
      });

      const auth = await guardBetterAuthRequest(
        customMutation("/api/auth/sign-in/social", {
          headers: {
            "content-length": declaredLength,
            "content-type": "application/json",
          },
          body,
        }),
        securityEnv(),
      );
      expect(auth.ok).toBe(false);
      if (auth.ok) throw new Error("expected Better Auth rejection");
      await expect(auth.response.json()).resolves.toMatchObject({
        code: "content_length_mismatch",
      });
    }
  });

  it("rejects multipart on the removed organization bundle upload path", async () => {
    const result = await guardCustomApiMutation(
      customMutation("/api/organizations/example/scenarios/bundles", {
        headers: {
          "content-type": "multipart/form-data; boundary=intar-boundary",
        },
        body: "bundle",
      }),
      securityEnv(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected request rejection");
    expect(result.response.status).toBe(415);
    await expect(result.response.json()).resolves.toMatchObject({
      code: "json_required",
    });
  });

  it("keeps Better Auth OIDC callbacks reachable but blocks tenant IdP and SAML paths", async () => {
    const tenantMutation = await guardBetterAuthRequest(
      new Request("https://intar.dev/api/auth/sign-in/sso", {
        method: "POST",
        headers: {
          origin: "https://idp.tenant.example",
          "sec-fetch-site": "cross-site",
        },
      }),
      securityEnv(),
    );
    expect(tenantMutation.ok).toBe(false);
    if (!tenantMutation.ok) {
      expect(tenantMutation.response.status).toBe(403);
    }

    const oidcCallback = await guardBetterAuthRequest(
      new Request(
        "https://intar.dev/api/auth/sso/callback/provider-oidc?code=code&state=state",
      ),
      securityEnv(),
    );
    expect(oidcCallback.ok).toBe(true);

    const samlCallback = await guardBetterAuthRequest(
      new Request("https://intar.dev/api/auth/sso/saml2/callback/provider"),
      securityEnv(),
    );
    expect(samlCallback.ok).toBe(false);
    if (!samlCallback.ok) {
      expect(samlCallback.response.status).toBe(404);
    }

    const samlMutation = await guardBetterAuthRequest(
      customMutation("/api/auth/sso/saml/register", {
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      securityEnv(),
    );
    expect(samlMutation.ok).toBe(false);
    if (!samlMutation.ok) {
      expect(samlMutation.response.status).toBe(404);
    }
  });

  it("bounds Better Auth protocol bodies without requiring JSON", async () => {
    const oversized = await guardBetterAuthRequest(
      customMutation("/api/auth/sign-in/social", {
        headers: { "content-type": "application/json" },
        body: "x".repeat(MAX_API_JSON_BODY_BYTES + 1),
      }),
      securityEnv(),
    );
    expect(oversized.ok).toBe(false);
    if (oversized.ok) throw new Error("expected Better Auth body rejection");
    expect(oversized.response.status).toBe(413);

    const formBody = "grant_type=authorization_code&code=test";
    const form = await guardBetterAuthRequest(
      customMutation("/api/auth/oauth2/token", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody,
      }),
      securityEnv(),
    );
    expect(form.ok).toBe(true);
    if (!form.ok) return;
    expect(
      new TextDecoder().decode(await form.request.arrayBuffer()),
    ).toBe(formBody);

    const emptyForm = await guardBetterAuthRequest(
      customMutation("/api/auth/sign-out", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new Uint8Array(),
      }),
      securityEnv(),
    );
    expect(emptyForm.ok).toBe(true);
    if (!emptyForm.ok) return;
    expect(emptyForm.request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect((await emptyForm.request.arrayBuffer()).byteLength).toBe(0);
  });

  it("uses the shared 20-per-minute namespace for every expensive action", () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const path of ["/api/support/topics", "/api/support/topics/topic", "/api/support/topics/topic/comments", "/api/support/topics/topic/comments/comment"]) {
        expect(sensitiveRateLimitActionFor(customMutation(path, { method }))).toBe("support-write");
      }
    }
    expect(sensitiveRateLimitActionFor(new Request("https://intar.dev/api/support/topics"))).toBeNull();
    expect(
      sensitiveRateLimitActionFor(customMutation("/api/scenarios/demo/start")),
    ).toBe("scenario-start");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/scenarios/runs/run-1/ssh"),
      ),
    ).toBe("ssh-issuance");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/admin/builds/build-1/retry"),
      ),
    ).toBe("build-retry");
    expect(
      sensitiveRateLimitActionFor(customMutation("/api/auth/sign-in/social")),
    ).toBe("auth-start");
    // Signed-out organization sign-in and connecting GitHub start OAuth too.
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/organization-sign-in/start"),
      ),
    ).toBe("auth-start");
    expect(
      sensitiveRateLimitActionFor(customMutation("/api/auth/link-social")),
    ).toBe("auth-start");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/account-links/sso/start"),
      ),
    ).toBe("sso-link");
    expect(
      sensitiveRateLimitActionFor(
        new Request("https://intar.dev/api/account-links/sso/start"),
      ),
    ).toBeNull();
    for (const path of [
      "/api/organizations/org/scenario-source",
      "/api/admin/scenario-source",
      "/api/admin/image-promotion",
    ]) {
      expect(sensitiveRateLimitActionFor(customMutation(path))).toBe(
        "scenario-source",
      );
      expect(
        sensitiveRateLimitActionFor(new Request(`https://intar.dev${path}`)),
      ).toBeNull();
    }
  });

  it("charges a route's own key and keeps address keys for everything else", async () => {
    const keys: string[] = [];
    const limiter = securityEnv(async ({ key }) => {
      keys.push(key);
      return { success: true };
    });
    const request = customMutation("/api/organizations/org/scenario-source", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    await enforceRateLimit(request, limiter, "scenario-source", "user:u1");
    await enforceRateLimit(request, limiter, "scenario-source");
    await enforceRateLimit(request, limiter, "sso-link");
    expect(keys[0]).toBe("web-edge:scenario-source:user:u1");
    expect(keys[1]).toMatch(/^web-edge:scenario-source:[0-9a-f]{24}$/u);
    expect(keys[2]).toBe(keys[1]?.replace("scenario-source", "sso-link"));
  });

  it("charges the sso-link action before the SSO start route reads its body", async () => {
    const keys: string[] = [];
    const request = customMutation("/api/account-links/sso/start", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "content-type": "application/json",
      },
      body: JSON.stringify({ organizationSlug: "team" }),
    });
    if (!request.body) throw new Error("expected request body");
    const getReader = vi.spyOn(request.body, "getReader");

    const result = await secureApplicationApiRequest(
      request,
      securityEnv(async ({ key }) => {
        keys.push(key);
        return { success: false };
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(getReader).not.toHaveBeenCalled();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^web-edge:sso-link:[0-9a-f]{24}$/u);
    expect(keys[0]).not.toContain("203.0.113.7");
  });

  it("fails closed when the shared rate limiter rejects or is unavailable", async () => {
    const rejected = await secureApplicationApiRequest(
      customMutation("/api/scenarios/demo/start"),
      securityEnv(async () => ({ success: false })),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.response.status).toBe(429);
      expect(rejected.response.headers.get("retry-after")).toBe("60");
    }

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const unavailable = await secureApplicationApiRequest(
      customMutation("/api/scenarios/demo/start"),
      securityEnv(async () => {
        throw new Error("rate limit unavailable");
      }),
    );
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.response.status).toBe(503);
    }
    consoleError.mockRestore();
  });
});

describe("clientNetwork", () => {
  it("keys IPv4 by address and IPv6 by its /64", () => {
    expect(clientNetwork("198.51.100.7")).toBe("198.51.100.7");
    expect(clientNetwork("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(clientNetwork("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
    expect(clientNetwork("2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd")).toBe(
      "2001:db8:0:1::/64",
    );
    expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientNetwork("::1")).toBe("0:0:0:0::/64");
  });
});
