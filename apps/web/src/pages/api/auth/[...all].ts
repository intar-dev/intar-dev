import { traceOperation } from "@/lib/tracing";
import type { APIRoute } from "astro";
import { isAPIError } from "better-auth/api";
import { auth } from "../../../lib/auth";
import { accessInviteError } from "@/lib/access-invite-http";
import {
  fixedOidcErrorResponse,
  isOidcSsoErrorBoundaryRequest,
  sanitizeOidcErrorResponse,
} from "@/lib/oidc-callback-error";
import { withErrorCode } from "@/lib/organization-sso-errors";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  try {
    return await authorizeRefusalRedirect(
      request,
      sanitizeOidcErrorResponse(
        request,
        await traceOperation("auth.handle", () => auth.handler(request)),
      ),
    );
  } catch (error) {
    if (isOidcSsoErrorBoundaryRequest(request)) {
      console.warn(JSON.stringify({ event: "oidc_auth_request_failed" }));
      return fixedOidcErrorResponse(request);
    }
    // A GitHub callback's session can be refused after its response is built,
    // when access changed meanwhile; the landing page explains the code.
    const url = new URL(request.url);
    const code = isAPIError(error) ? error.body?.code : undefined;
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/auth/callback/") &&
      typeof code === "string"
    ) {
      return Response.redirect(withErrorCode("/", code, url.origin), 302);
    }
    return accessInviteError(error, "the authentication request was rejected");
  }
};

/**
 * Browsers navigate to an app's authorization link. When Intar refuses the
 * session there (an impersonation, or an account that lost access), the
 * landing page explains the code instead of showing JSON.
 */
async function authorizeRefusalRedirect(
  request: Request,
  response: Response,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.pathname !== "/api/auth/oauth2/authorize" ||
    (response.status !== 401 && response.status !== 403)
  ) {
    return response;
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return typeof body?.code === "string"
    ? Response.redirect(withErrorCode("/", body.code, url.origin), 302)
    : response;
}
