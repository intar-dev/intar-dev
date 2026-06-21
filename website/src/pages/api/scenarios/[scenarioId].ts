import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { loadEnabledScenarioForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }

  const scenario = await loadEnabledScenarioForUser({
    scenarioId,
    userId: authz.context.userId,
  });
  if (!scenario) {
    return jsonResponse({ error: "scenario not found" }, { status: 404 });
  }

  return jsonResponse({ scenario });
};
