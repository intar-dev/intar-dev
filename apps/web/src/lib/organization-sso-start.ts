import { isAPIError } from "better-auth/api";
import { appError, type AppError } from "@/lib/app-error";
import { auth } from "@/lib/auth";
import {
  createSsoIntent,
  ORGANIZATION_SSO_SCOPES,
  SSO_INTENT_HEADER,
  SSO_INTENT_TTL_MS,
} from "@/lib/organization-sso";
import { SSO_ERROR_MESSAGES } from "@/lib/organization-sso-errors";
import { copySetCookies } from "@/lib/response-cookies";

export type OrganizationSsoStartIntent =
  | { kind: "sign-in"; providerId: string }
  | { kind: "link"; providerId: string; userId: string };

// The before hook's refusals of a start, all 403s.
const KNOWN_START_ERRORS: Record<string, string> = {
  sso_intent_mismatch: "Sign in again, then connect your organization",
  impersonation_link_forbidden: SSO_ERROR_MESSAGES.impersonation_link_forbidden,
  session_not_fresh:
    "Connecting your organization needs a recent sign-in. Sign out, sign in again, and connect it then.",
};

/**
 * Starts the SSO plugin's PKCE flow with a signed intent. The before hook
 * verifies the intent and stores it in the OAuth state for the callback.
 */
export async function startOrganizationSso(input: {
  request: Request;
  intent: OrganizationSsoStartIntent;
  callbackURL: string;
  errorCallbackURL: string;
}): Promise<{ redirectUrl: string; headers: Headers }> {
  const token = await createSsoIntent({
    ...input.intent,
    expiresAt: Date.now() + SSO_INTENT_TTL_MS,
  });
  const headers = new Headers(input.request.headers);
  headers.set(SSO_INTENT_HEADER, token);

  let authResponse: Response;
  try {
    authResponse = await auth.api.signInSSO({
      body: {
        providerId: input.intent.providerId,
        providerType: "oidc",
        callbackURL: input.callbackURL,
        errorCallbackURL: input.errorCallbackURL,
        scopes: ORGANIZATION_SSO_SCOPES,
      },
      headers,
      asResponse: true,
    });
  } catch (error) {
    if (isAPIError(error)) {
      throw startError(error.body?.code, error.statusCode);
    }
    // Not a refusal: a database or configuration failure. The response stays
    // generic, so the cause is logged here.
    console.warn(
      JSON.stringify({
        event: "organization_sso_start_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw startError(undefined);
  }
  if (!authResponse.ok) {
    const body = (await authResponse.json().catch(() => null)) as {
      code?: unknown;
    } | null;
    throw startError(
      typeof body?.code === "string" ? body.code : undefined,
      authResponse.status,
    );
  }

  const result = (await authResponse.json()) as {
    url?: unknown;
    redirect?: unknown;
  };
  if (typeof result.url !== "string" || result.redirect !== true) {
    throw new Error("Better Auth did not return an SSO redirect");
  }
  const responseHeaders = new Headers();
  copySetCookies(authResponse.headers, responseHeaders);
  return { redirectUrl: result.url, headers: responseHeaders };
}

// Keep provider and discovery details out of the response: only app-owned
// codes pass through, with fixed messages. Others are logged by code only,
// since their messages can carry the provider's discovery details.
function startError(code: string | undefined, status?: number): AppError {
  const known =
    code && Object.hasOwn(KNOWN_START_ERRORS, code)
      ? KNOWN_START_ERRORS[code]
      : undefined;
  if (code && known) return appError(403, code, known);
  if (status !== undefined) {
    console.warn(
      JSON.stringify({
        event: "organization_sso_start_refused",
        status,
        code: code ?? null,
      }),
    );
  }
  return appError(
    502,
    "organization_sign_in_unavailable",
    "organization sign-in could not be started",
  );
}
