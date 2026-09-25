import type { APIRoute } from "astro";
import {
  accessInviteError,
  accessInviteNoStore,
} from "@/lib/access-invite-http";
import { requireUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import {
  organizationSsoStartResponse,
  readOrganizationSsoTarget,
} from "@/lib/organization-sso-routes";

export const prerender = false;

// Signs in, or creates an account, through an organization's identity
// provider. A signed-in account connects its organization through
// /api/account-links/sso/start instead, and a revoked session keeps its
// refusal. The worker charges the "auth-start" rate limit before this route.
export const POST: APIRoute = async ({ request }) => {
  try {
    const authz = await requireUserContext(request);
    if (authz.ok) {
      throw appError(
        409,
        "already_signed_in",
        "you are already signed in; connect your organization instead",
      );
    }
    if (authz.response.status !== 401) {
      return accessInviteNoStore(authz.response);
    }
    const target = await readOrganizationSsoTarget(request);
    return await organizationSsoStartResponse({
      request,
      intent: { kind: "sign-in", providerId: target.providerId },
      callbackURL: target.organizationURL,
      errorCallbackURL: `${target.organizationURL}/sign-in`,
    });
  } catch (error) {
    return accessInviteError(error, "organization sign-in could not be started");
  }
};
