import type { APIRoute } from "astro";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore } from "@/lib/access-invite-http";
import { listOrganizationServers, requireOrganizationServerAccess } from "@/lib/organization-servers";

export const prerender = false;
export const GET: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const organizationId = await requireOrganizationServerAccess(auth.context, params.orgId ?? "");
    return accessInviteJson(await listOrganizationServers(auth.context, organizationId));
  } catch (error) { return accessInviteError(error, "Could not load organization servers. Try again."); }
};
