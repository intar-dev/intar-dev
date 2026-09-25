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
import { requireOrganizationRole } from "@/lib/organizations";

export const prerender = false;

// Connects an organization's identity provider to the signed-in account, or
// runs the owner's Test sign-in. The worker charges the shared "sso-link" rate
// limit before this route runs.
export const POST: APIRoute = async ({ request }) => {
  try {
    const authz = await requireUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const target = await readOrganizationSsoTarget(request);
    const { organizationId } = target;
    const testSignIn = target.body.test === true;
    if (testSignIn) {
      const role = await requireOrganizationRole({
        organizationId,
        userId: authz.context.userId,
      });
      if (role !== "owner") {
        throw appError(
          403,
          "organization_owner_required",
          "only the organization owner can test sign-in",
        );
      }
    }
    return await organizationSsoStartResponse({
      request,
      intent: {
        kind: "link",
        providerId: target.providerId,
        userId: authz.context.userId,
      },
      callbackURL: testSignIn
        ? `${target.organizationURL}?tab=settings&oidcTest=passed`
        : target.organizationURL,
      errorCallbackURL: testSignIn
        ? target.organizationURL
        : `${target.organizationURL}/sign-in`,
    });
  } catch (error) {
    return accessInviteError(error, "organization SSO could not be started");
  }
};
