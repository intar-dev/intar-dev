import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { startScenarioRunForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  try {
    const result = await startScenarioRunForUser({
      scenarioId,
      userId: authz.context.userId,
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to start scenario",
    );
    return jsonResponse(body, { status });
  }
};
