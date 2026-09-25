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
    // Pages look the message up by code.
    expect(location.searchParams.has("error_description")).toBe(false);
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
    expect(location.searchParams.has("error_description")).toBe(false);
    expect(location.toString()).not.toContain("confidential");

    // A browser that followed the provider back must not land on JSON.
    const detailedError = new Response(upstreamDetail, { status: 502 });
    const fixedError = sanitizeOidcErrorResponse(
      callbackRequest(),
      detailedError,
    );
    expect(fixedError.status).toBe(302);
    expect(fixedError.headers.get("cache-control")).toContain("no-store");
    expect(fixedError.headers.get("location")).toBe(
      "https://intar.dev/organization-sign-in?error=oidc_sign_in_failed",
    );
    await expect(fixedError.text()).resolves.not.toContain(upstreamDetail);
  });

  it("never lets the identity provider pick one of Intar's codes", () => {
    // The SSO plugin copies the provider's `error` into the redirect.
    const request = new Request(
      "https://intar.dev/api/auth/sso/callback/org-provider?error=access_revoked&state=state",
    );
    for (const code of [
      "access_revoked",
      "sso_removed_from_organization",
      "signups_full",
    ]) {
      const sanitized = sanitizeOidcErrorResponse(
        request,
        callbackRedirect(`error=${code}`),
      );
      const location = new URL(sanitized.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("oidc_sign_in_failed");
    }
  });

  it("passes app codes through without any description", () => {
    const sanitized = sanitizeOidcErrorResponse(
      callbackRequest(),
      callbackRedirect(
        "error=sso_email_in_use&error_description=Call%20attacker%20support",
      ),
    );
    const location = new URL(sanitized.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("sso_email_in_use");
    expect(location.searchParams.has("error_description")).toBe(false);

    for (const [source, expected] of [
      ["account not linked", "sso_email_in_use"],
      ["signups_full", "signups_full"],
      ["sso_removed_from_organization", "sso_removed_from_organization"],
      ["constructor", "oidc_sign_in_failed"],
      ["toString", "oidc_sign_in_failed"],
    ] as const) {
      const mapped = sanitizeOidcErrorResponse(
        callbackRequest(),
        callbackRedirect(`error=${encodeURIComponent(source)}`),
      );
      expect(
        new URL(mapped.headers.get("location")!).searchParams.get("error"),
      ).toBe(expected);
    }
  });

  it("sends generic error pages to organization sign-in", () => {
    for (const target of [
      "https://intar.dev/api/auth/error?error=invalid_state",
      // Better Auth's onAPIError.errorURL.
      "https://intar.dev/?error=invalid_state",
    ]) {
      const sanitized = sanitizeOidcErrorResponse(
        callbackRequest(),
        Response.redirect(target, 302),
      );
      const location = new URL(sanitized.headers.get("location")!);
      expect(location.pathname).toBe("/organization-sign-in");
      expect(location.searchParams.get("error")).toBe("oidc_sign_in_failed");
    }
  });

  it("names a missing email claim so the provider's admin can fix it", () => {
    const sanitized = sanitizeOidcErrorResponse(
      callbackRequest(),
      callbackRedirect("error=invalid_provider&error_description=missing_user_info"),
    );
    expect(
      new URL(sanitized.headers.get("location")!).searchParams.get("error"),
    ).toBe("oidc_email_missing");

    // The provider itself can't claim it.
    const reported = sanitizeOidcErrorResponse(
      new Request(
        "https://intar.dev/api/auth/sso/callback/org-provider?error=invalid_provider&error_description=missing_user_info&state=state",
      ),
      callbackRedirect("error=invalid_provider&error_description=missing_user_info"),
    );
    expect(
      new URL(reported.headers.get("location")!).searchParams.get("error"),
    ).toBe("oidc_sign_in_failed");
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
