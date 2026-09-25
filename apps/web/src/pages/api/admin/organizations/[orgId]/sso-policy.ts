import type { APIRoute } from "astro";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { setOrganizationOidcPolicy } from "@/lib/organization-oidc";
import { resolveOrganizationId } from "@/lib/organizations";
import { canonicalApplicationOrigin } from "@/lib/request-security";

export const prerender = false;

// Platform admins approve an organization's identity provider for sign-ups
// with emails outside its verified domain.
export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const organizationId = await resolveOrganizationId(params.orgId ?? "");
    if (!organizationId) {
      throw appError(404, "organization_not_found", "organization not found");
    }
    const body = await readJsonObject(request);
    const provider = await setOrganizationOidcPolicy({
      organizationId,
      actorUserId: authz.context.userId,
      allowExternalEmailSignups: body.allowExternalEmailSignups,
      baseUrl: canonicalApplicationOrigin(),
    });
    return accessInviteJson({ provider });
  } catch (error) {
    return accessInviteError(error, "The sign-up policy could not be saved");
  }
};
