import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  listScenarioSources,
  saveScenarioSource,
} from "@/lib/scenario-sources";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const sources = await listScenarioSources();
    return jsonResponse({ sources });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to list sources");
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const body = (await request.json().catch(() => null)) as {
    scenarioId?: unknown;
    hcl?: unknown;
  } | null;
  const scenarioId =
    typeof body?.scenarioId === "string" ? body.scenarioId : "";
  const hcl = typeof body?.hcl === "string" ? body.hcl : "";

  try {
    const source = await saveScenarioSource({
      scenarioId,
      hcl,
      userId: authz.context.userId,
    });
    return jsonResponse({ source }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to save source",
    );
    return jsonResponse(errorBody, { status });
  }
};
