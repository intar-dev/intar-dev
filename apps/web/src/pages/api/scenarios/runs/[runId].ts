import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  deleteFinishedScenarioRunForUser,
  getScenarioRunForUser,
} from "@/lib/scenario-runs";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  try {
    const run = await getScenarioRunForUser({
      runId,
      userId: authz.context.userId,
    });
    return jsonResponse({ run });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load scenario run");
    return jsonResponse(body, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  try {
    await deleteFinishedScenarioRunForUser({
      runId,
      userId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to delete run");
    return jsonResponse(body, { status });
  }
};
