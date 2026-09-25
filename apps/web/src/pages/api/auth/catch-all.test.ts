import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("../../../lib/auth", () => ({ auth: { handler: mocks.handler } }));
vi.mock("@/lib/tracing", () => ({
  traceOperation: (_name: string, operation: () => unknown) => operation(),
}));
vi.mock("@/lib/request-security", () => ({
  NO_STORE_HEADERS: { "cache-control": "no-store" },
}));

import { ALL } from "./[...all]";

describe("auth route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a GitHub callback refused after its response to the landing page", async () => {
    // A session refused by its after hook surfaces once the response exists.
    mocks.handler.mockRejectedValueOnce(
      new APIError("FORBIDDEN", { code: "access_revoked", message: "no access" }),
    );
    const response = await ALL({
      request: new Request(
        "https://intar.test/api/auth/callback/github?code=c&state=s",
      ),
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://intar.test/?error=access_revoked",
    );
  });

  it("sends a refused app authorization to the landing page", async () => {
    // The before hook's refusal comes back as a JSON response.
    mocks.handler.mockResolvedValueOnce(
      Response.json(
        { code: "impersonation_oauth_forbidden", message: "Stop impersonating" },
        { status: 403 },
      ),
    );
    const response = await ALL({
      request: new Request(
        "https://intar.test/api/auth/oauth2/authorize?client_id=app&response_type=code",
      ),
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://intar.test/?error=impersonation_oauth_forbidden",
    );
  });

  it("keeps JSON errors for other auth requests", async () => {
    mocks.handler.mockRejectedValueOnce(
      new APIError("FORBIDDEN", { code: "access_revoked", message: "no access" }),
    );
    const response = await ALL({
      request: new Request("https://intar.test/api/auth/get-session"),
    } as never);

    expect(response.status).not.toBe(302);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
