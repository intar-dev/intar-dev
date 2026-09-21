import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore } from "@/lib/access-invite-http";
import { cancelOrganizationEnrollment, requireOrganizationServerAccess } from "@/lib/organization-servers";

export const prerender = false;
export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const organizationId = await requireOrganizationServerAccess(auth.context, params.orgId ?? "", true);
    await cancelOrganizationEnrollment(env.DB, auth.context, organizationId, params.enrollmentId ?? "");
    return accessInviteJson({ canceled: true });
  } catch (error) { return accessInviteError(error, "Could not cancel server setup. Try again."); }
};
