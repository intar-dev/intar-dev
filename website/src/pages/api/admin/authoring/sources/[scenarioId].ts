import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  deleteScenarioSource,
  getScenarioSource,
} from "@/lib/scenario-sources";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }

  try {
    const source = await getScenarioSource(scenarioId);
    if (!source) {
      return jsonResponse({ error: "source not found" }, { status: 404 });
    }
    return jsonResponse({ source });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load source");
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

  try {
    await deleteScenarioSource(scenarioId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to delete source");
    return jsonResponse(body, { status });
  }
};
