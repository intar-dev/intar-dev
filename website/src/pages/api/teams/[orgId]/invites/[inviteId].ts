import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { revokeTeamInvite } from "@/lib/teams";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  const inviteId = params.inviteId?.trim() ?? "";
  if (!orgId || !inviteId) {
    return jsonResponse(
      { error: "orgId and inviteId are required" },
      { status: 400 },
    );
  }

  try {
    await revokeTeamInvite({
      organizationId: orgId,
      inviteId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to revoke invite");
    return jsonResponse(body, { status });
  }
};
