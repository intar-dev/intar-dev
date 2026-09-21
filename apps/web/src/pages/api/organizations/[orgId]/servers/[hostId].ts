import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore, readJsonObject } from "@/lib/access-invite-http";
import { appError } from "@/lib/app-error";
import { removeOrganizationServer, requireOrganizationServerAccess, updateOrganizationServer } from "@/lib/organization-servers";

export const prerender = false;
export const PATCH: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const organizationId = await requireOrganizationServerAccess(auth.context, params.orgId ?? "", true);
    await updateOrganizationServer(env.DB, auth.context, organizationId, params.hostId ?? "", await readJsonObject(request));
    return accessInviteJson({ updated: true });
  } catch (error) { return accessInviteError(error, "Could not update the organization server. Try again."); }
};
export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const organizationId = await requireOrganizationServerAccess(auth.context, params.orgId ?? "", true);
    const input = await readJsonObject(request);
    if (typeof input.confirmReturnToCloud !== "boolean" || Object.keys(input).some(key => key !== "confirmReturnToCloud")) {
      throw appError(400, "removal_confirmation_required", "Confirm server removal in organization servers.");
    }
    return accessInviteJson(await removeOrganizationServer(env.DB, auth.context, organizationId, params.hostId ?? "", input.confirmReturnToCloud), { status: 202 });
  } catch (error) { return accessInviteError(error, "Could not remove the organization server. Try again."); }
};
