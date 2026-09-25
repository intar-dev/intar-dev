import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import {
  resolveOrganizationId,
  restoreRemovedMemberAsPlatformAdmin,
} from "@/lib/organizations";

export const prerender = false;

// A platform admin restores someone an organization removed. They rejoin on
// their next organization sign-in.
export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;
  const userId = params.userId?.trim() ?? "";
  if (!userId) {
    return jsonResponse({ error: "userId is required" }, { status: 400 });
  }

  try {
    const organizationId = await resolveOrganizationId(params.orgId ?? "");
    if (!organizationId) {
      throw appError(404, "organization_not_found", "organization not found");
    }
    await restoreRemovedMemberAsPlatformAdmin({
      organizationId,
      userId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to restore member");
    return jsonResponse(body, { status });
  }
};
