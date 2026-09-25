import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import {
  listOrganizationRemovedMembers,
  resolveOrganizationId,
} from "@/lib/organizations";

export const prerender = false;

// Who an organization's admins removed, for platform admins, who need no
// membership to see it.
export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    const organizationId = await resolveOrganizationId(params.orgId ?? "");
    if (!organizationId) {
      throw appError(404, "organization_not_found", "organization not found");
    }
    return accessInviteJson({
      removedMembers: await listOrganizationRemovedMembers(organizationId),
    });
  } catch (error) {
    return accessInviteError(error, "failed to list removed members");
  }
};
