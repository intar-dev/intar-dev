import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { serializeAdminScenarioDetail } from "@/lib/admin-scenario-response";
import { toErrorResponse } from "@/lib/app-error";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { disableScenario, enableScenario } from "@/lib/scenarios";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  try {
    const scenario = await enableScenario({
      scenarioId,
    });
    return jsonResponse({ scenario: serializeAdminScenarioDetail(scenario) });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to enable scenario",
    );
    return jsonResponse(body, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  try {
    const scenario = await disableScenario({
      scenarioId,
    });
    return jsonResponse({ scenario: serializeAdminScenarioDetail(scenario) });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to disable scenario",
    );
    return jsonResponse(body, { status });
  }
};
