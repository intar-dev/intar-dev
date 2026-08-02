import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { revealScenarioRunHintForUser } from "@/lib/scenario-hints";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    hintKey?: unknown;
  } | null;
  const hintKey = typeof body?.hintKey === "string" ? body.hintKey.trim() : "";
  if (!hintKey) {
    return jsonResponse({ error: "hintKey is required" }, { status: 400 });
  }

  try {
    const run = await revealScenarioRunHintForUser({
      runId,
      userId: authz.context.userId,
      hintKey,
    });
    return jsonResponse({ run });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to reveal hint");
    return jsonResponse(body, { status });
  }
};
