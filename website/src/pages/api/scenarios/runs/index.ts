import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listScenarioRunsForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const runs = await listScenarioRunsForUser({
      userId: authz.context.userId,
    });
    return jsonResponse({ runs });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list scenario runs",
    );
    return jsonResponse(body, { status });
  }
};
