/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";
import {
  MAX_API_JSON_BODY_BYTES,
  MAX_ORGANIZATION_SCENARIO_BUNDLE_MULTIPART_BYTES,
  guardBetterAuthRequest,
  guardCustomApiMutation,
  secureApplicationApiRequest,
  sensitiveRateLimitActionFor,
} from "./request-security";

function securityEnv(
  limit: (input: { key: string }) => Promise<{ success: boolean }> = async () => ({
    success: true,
  }),
) {
  return {
    BETTER_AUTH_URL: "https://intar.dev",
    ACCESS_INVITE_RATE_LIMITER: { limit },
  } as Pick<
    Cloudflare.Env,
    "ACCESS_INVITE_RATE_LIMITER" | "BETTER_AUTH_URL"
  >;
}

function customMutation(
  pathname: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers({
    origin: "https://intar.dev",
    "sec-fetch-site": "same-origin",
  });
  for (const [name, value] of new Headers(init.headers)) {
    headers.set(name, value);
  }
  return new Request(`https://intar.dev${pathname}`, {
    ...init,
    method: "POST",
    headers,
  });
}

async function responseBody(result: Awaited<ReturnType<typeof guardCustomApiMutation>>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected request rejection");
  return result.response.json() as Promise<{ error: string; code: string }>;
}

describe("worker API request security", () => {
  it("accepts exact-origin bodyless custom mutations", async () => {
    const result = await secureApplicationApiRequest(
      customMutation("/api/admin/builds/build-1/retry"),
      securityEnv(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toBeNull();
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

  it("accepts multipart only for declared, bounded organization bundle uploads", async () => {
    const valid = await guardCustomApiMutation(
      customMutation("/api/organizations/example/scenarios/bundles", {
        headers: {
          "content-type": "multipart/form-data; boundary=intar-boundary",
          "content-length": String(
            MAX_ORGANIZATION_SCENARIO_BUNDLE_MULTIPART_BYTES,
          ),
        },
        body: "bundle",
      }),
      securityEnv(),
    );
    expect(valid.ok).toBe(true);

    for (const [headers, status, code] of [
      [
        { "content-type": "multipart/form-data; boundary=intar-boundary" },
        411,
        "content_length_required",
      ],
      [
        {
          "content-type": "multipart/form-data; boundary=intar-boundary",
          "content-length": "065",
        },
        400,
        "invalid_content_length",
      ],
      [
        {
          "content-type": "application/json",
          "content-length": "10",
        },
        415,
        "multipart_required",
      ],
      [
        {
          "content-type": "multipart/form-data; boundary=intar-boundary",
          "content-length": String(
            MAX_ORGANIZATION_SCENARIO_BUNDLE_MULTIPART_BYTES + 1,
          ),
        },
        413,
        "bundle_request_too_large",
      ],
    ] as const) {
      const result = await guardCustomApiMutation(
        customMutation("/api/organizations/example/scenarios/bundles", {
          headers,
          body: "bundle",
        }),
        securityEnv(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected request rejection");
      expect(result.response.status).toBe(status);
      await expect(result.response.json()).resolves.toMatchObject({ code });
    }
  });

  it("keeps Better Auth OIDC callbacks reachable but blocks tenant IdP and SAML paths", () => {
    const tenantMutation = guardBetterAuthRequest(
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

    const oidcCallback = guardBetterAuthRequest(
      new Request(
        "https://intar.dev/api/auth/sso/callback/provider-oidc?code=code&state=state",
      ),
      securityEnv(),
    );
    expect(oidcCallback.ok).toBe(true);

    const samlCallback = guardBetterAuthRequest(
      new Request("https://intar.dev/api/auth/sso/saml2/callback/provider"),
      securityEnv(),
    );
    expect(samlCallback.ok).toBe(false);
    if (!samlCallback.ok) {
      expect(samlCallback.response.status).toBe(404);
    }

    const samlMutation = guardBetterAuthRequest(
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

  it("uses the shared 20-per-minute namespace for every expensive action", () => {
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/scenarios/demo/start"),
      ),
    ).toBe("scenario-start");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/organizations/org/workshop-sessions"),
      ),
    ).toBe("workshop-start");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/scenarios/runs/run-1/ssh"),
      ),
    ).toBe("ssh-issuance");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/workshops/session-1/terminal"),
      ),
    ).toBe("terminal-issuance");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/admin/builds/build-1/retry"),
      ),
    ).toBe("build-retry");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/organizations/org/workshop-providers"),
      ),
    ).toBe("provider-connect");
    expect(
      sensitiveRateLimitActionFor(
        customMutation(
          "/api/organizations/org/workshop-providers/connection/rotate",
        ),
      ),
    ).toBe("provider-rotate");
    expect(
      sensitiveRateLimitActionFor(
        customMutation(
          "/api/organizations/org/workshop-providers/connection/manual-cleanup",
        ),
      ),
    ).toBe("provider-cleanup");
    expect(
      sensitiveRateLimitActionFor(
        customMutation("/api/auth/sign-in/social"),
      ),
    ).toBe("auth-start");
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

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
