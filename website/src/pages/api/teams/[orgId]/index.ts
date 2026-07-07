import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { getTeamDetail } from "@/lib/teams";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const team = await getTeamDetail({
      organizationId: orgId,
      userId: authz.context.userId,
    });
    return jsonResponse({ team });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load team");
    return jsonResponse(body, { status });
  }
};
