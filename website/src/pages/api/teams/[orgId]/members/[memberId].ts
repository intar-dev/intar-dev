import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { removeTeamMember } from "@/lib/teams";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  const memberId = params.memberId?.trim() ?? "";
  if (!orgId || !memberId) {
    return jsonResponse(
      { error: "orgId and memberId are required" },
      { status: 400 },
    );
  }

  try {
    await removeTeamMember({
      organizationId: orgId,
      memberId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to remove member");
    return jsonResponse(body, { status });
  }
};
