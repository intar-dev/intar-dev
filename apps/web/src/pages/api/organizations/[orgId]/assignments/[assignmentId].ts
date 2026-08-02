import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { unassignScenarioFromOrganization } from "@/lib/assignments";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  const assignmentId = params.assignmentId?.trim() ?? "";
  if (!organizationId || !assignmentId) {
    return jsonResponse(
      { error: "orgId and assignmentId are required" },
      { status: 400 },
    );
  }

  try {
    await unassignScenarioFromOrganization({
      organizationId,
      assignmentId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to remove assignment",
    );
    return jsonResponse(body, { status });
  }
};
