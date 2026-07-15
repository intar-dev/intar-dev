import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { destroyScenarioRunForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  try {
    const result = await destroyScenarioRunForUser({
      runId,
      userId: authz.context.userId,
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to destroy scenario",
    );
    return jsonResponse(body, { status });
  }
};
