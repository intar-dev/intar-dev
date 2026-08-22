import type { APIRoute } from "astro";
import { auth } from "../../../lib/auth";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import {
  isOidcSsoErrorBoundaryRequest,
  sanitizeOidcErrorResponse,
} from "@/lib/oidc-callback-error";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  try {
    return sanitizeOidcErrorResponse(request, await auth.handler(request));
  } catch (error) {
    if (isOidcSsoErrorBoundaryRequest(request)) {
      console.warn(JSON.stringify({ event: "oidc_auth_request_failed" }));
      return accessInviteJson(
        { error: "OIDC sign-in failed", code: "oidc_sign_in_failed" },
        { status: 400 },
      );
    }
    return accessInviteError(error, "the authentication request was rejected");
  }
};
