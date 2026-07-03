import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { revealScenarioRunSolutionForUser } from "@/lib/scenario-hints";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  try {
    const run = await revealScenarioRunSolutionForUser({
      runId,
      userId: authz.context.userId,
    });
    return jsonResponse({ run });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to reveal solution");
    return jsonResponse(body, { status });
  }
};
