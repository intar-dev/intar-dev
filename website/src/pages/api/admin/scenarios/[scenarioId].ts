import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { serializeAdminScenarioDetail } from "@/lib/admin-scenario-response";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { loadScenario } from "@/lib/scenarios";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  const scenario = await loadScenario(scenarioId);
  if (!scenario) {
    return jsonResponse({ error: "scenario not found" }, { status: 404 });
  }

  return jsonResponse({ scenario: serializeAdminScenarioDetail(scenario) });
};
