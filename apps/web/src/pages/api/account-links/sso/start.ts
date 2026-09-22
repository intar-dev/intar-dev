import type { APIRoute } from "astro";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { resolveBetaOidcProvider } from "@/lib/access-sso";
import { requireUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { getBetaAccess } from "@/lib/allowlist";
import {
  auth,
  createSsoLinkOAuthHandoff,
  INVITE_OAUTH_HANDOFF_HEADER,
} from "@/lib/auth";
import {
  canonicalApplicationOrigin,
  rateLimitPublicAccessInvite,
} from "@/lib/request-security";
import { copySetCookies } from "@/lib/response-cookies";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    await rateLimitPublicAccessInvite({ request, action: "sso-link" });
    const authz = await requireUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const identity = await getAccessClaimIdentity(request);
    if (!identity?.githubAccountId || identity.accessState !== "active") {
      throw appError(
        403,
        "active_github_session_required",
        "connect SSO from an active GitHub beta session",
      );
    }
    const body = await readJsonObject(request);
    if (typeof body.organizationSlug !== "string") {
      throw appError(
        400,
        "organization_slug_required",
        "organization slug is required",
      );
    }
    const provider = await resolveBetaOidcProvider(body.organizationSlug);
    const testSignIn = body.test === true;
    if (testSignIn) {
      const organizationId = await resolveOrganizationId(
        provider.organizationSlug,
      );
      const role =
        organizationId &&
        (await requireOrganizationRole({
          organizationId,
          userId: authz.context.userId,
        }));
      if (role !== "owner") {
        throw appError(
          403,
          "organization_owner_required",
          "only the organization owner can test sign-in",
        );
      }
    }
    const admission = await getBetaAccess(authz.context.userId);
    if (admission?.state !== "active") {
      throw appError(
        403,
        "active_github_session_required",
        "connect SSO from an active GitHub beta session",
      );
    }
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const handoff = await createSsoLinkOAuthHandoff({
      userId: authz.context.userId,
      providerId: provider.providerId,
      expiresAt,
      sourceInviteId: admission.sourceInviteId,
      sourceLeaseId: admission.sourceLeaseId,
      grantedAt: admission.grantedAt,
    });
    const headers = new Headers(request.headers);
    headers.set(INVITE_OAUTH_HANDOFF_HEADER, handoff);
    const origin = canonicalApplicationOrigin();
    const organizationURL = `${origin}/organizations/${encodeURIComponent(provider.organizationSlug)}`;
    const callbackURL = testSignIn
      ? `${organizationURL}?tab=settings&oidcTest=passed`
      : organizationURL;
    const authResponse = await auth.api.signInSSO({
      body: {
        providerId: provider.providerId,
        providerType: "oidc",
        callbackURL,
        errorCallbackURL: testSignIn
          ? organizationURL
          : `${organizationURL}/sign-in`,
        newUserCallbackURL: callbackURL,
        requestSignUp: false,
        scopes: ["openid", "email", "profile", "offline_access"],
      },
      headers,
      asResponse: true,
    });
    if (!authResponse.ok) {
      throw new Error(`Better Auth returned ${authResponse.status}`);
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
    return accessInviteJson(
      { redirectUrl: result.url, expiresAt },
      { headers: responseHeaders },
    );
  } catch (error) {
    return accessInviteError(error, "organization SSO could not be started");
  }
};
