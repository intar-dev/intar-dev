import { describe, expect, it } from "vitest";
import {
  isOidcSsoErrorBoundaryRequest,
  sanitizeOidcErrorResponse,
} from "./oidc-callback-error";

describe("OIDC callback error boundary", () => {
  it("replaces discovery detail with one fixed public error", () => {
    const upstreamDetail =
      "issuer https://secret-idp.example returned tenant-secret";
    const response = callbackRedirect(
      `error=discovery_failed&error_description=${encodeURIComponent(upstreamDetail)}`,
    );

    const sanitized = sanitizeOidcErrorResponse(callbackRequest(), response);
    const location = new URL(sanitized.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("oidc_discovery_failed");
    expect(location.searchParams.get("error_description")).toBe(
      "OIDC discovery failed",
    );
    expect(location.toString()).not.toContain("secret-idp");
    expect(location.toString()).not.toContain("tenant-secret");
  });

  it("also hides token and profile endpoint error text", async () => {
    const upstreamDetail = "token endpoint exposed confidential body";
    const response = callbackRedirect(
      `error=invalid_provider&error_description=${encodeURIComponent(upstreamDetail)}`,
    );

    const sanitized = sanitizeOidcErrorResponse(callbackRequest(), response);
    const location = new URL(sanitized.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("oidc_sign_in_failed");
    expect(location.searchParams.get("error_description")).toBe(
      "OIDC sign-in failed",
    );
    expect(location.toString()).not.toContain("confidential");

    const detailedError = new Response(upstreamDetail, { status: 502 });
    const fixedError = sanitizeOidcErrorResponse(
      callbackRequest(),
      detailedError,
    );
    expect(fixedError.status).toBe(400);
    expect(fixedError.headers.get("cache-control")).toContain("no-store");
    await expect(fixedError.text()).resolves.not.toContain(upstreamDetail);
  });

  it("leaves successful and unrelated redirects unchanged", () => {
    const success = Response.redirect(
      "https://intar.dev/organizations/example",
      302,
    );
    expect(sanitizeOidcErrorResponse(callbackRequest(), success)).toBe(success);

    const unrelated = callbackRedirect(
      "error=discovery_failed&error_description=upstream-detail",
    );
    const unrelatedRequest = new Request(
      "https://intar.dev/api/auth/callback/github",
    );
    expect(sanitizeOidcErrorResponse(unrelatedRequest, unrelated)).toBe(
      unrelated,
    );
    expect(isOidcSsoErrorBoundaryRequest(callbackRequest())).toBe(true);
    expect(
      isOidcSsoErrorBoundaryRequest(
        new Request("https://intar.dev/api/auth/sign-in/sso", {
          method: "POST",
        }),
      ),
    ).toBe(true);
    expect(isOidcSsoErrorBoundaryRequest(unrelatedRequest)).toBe(false);
  });

  it("hides sign-in discovery failures", async () => {
    const upstreamDetail = "legacy issuer exposed private discovery response";
    const request = new Request("https://intar.dev/api/auth/sign-in/sso", {
      method: "POST",
    });
    const sanitized = sanitizeOidcErrorResponse(
      request,
      new Response(upstreamDetail, { status: 500 }),
    );
    expect(sanitized.status).toBe(400);
    await expect(sanitized.text()).resolves.not.toContain(upstreamDetail);
  });
});

function callbackRequest(): Request {
  return new Request(
    "https://intar.dev/api/auth/sso/callback/org-provider?code=code&state=state",
  );
}

function callbackRedirect(query: string): Response {
  return Response.redirect(
    `https://intar.dev/organizations/example/sign-in?${query}`,
    302,
  );
}
