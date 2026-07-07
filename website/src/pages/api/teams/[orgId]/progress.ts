import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { getTeamProgress } from "@/lib/instructor-progress";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const progress = await getTeamProgress({
      organizationId: orgId,
      userId: authz.context.userId,
    });
    return jsonResponse({ progress });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load progress");
    return jsonResponse(body, { status });
  }
};
