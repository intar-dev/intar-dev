import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { startScenarioRunForUser } from "@/lib/scenario-runs";

export const prerender = false;

interface StartScenarioBody {
  hostId?: unknown;
  admissionMode?: unknown;
}

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

  let hostId: string | undefined;
  let admissionMode: "benchmark" | undefined;
  if (request.headers.get("content-type")?.includes("application/json")) {
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return jsonResponse({ error: "invalid json body" }, { status: 400 });
    }
    if (
      typeof parsedBody !== "object" ||
      parsedBody === null ||
      Array.isArray(parsedBody)
    ) {
      return jsonResponse(
        { error: "json body must be an object" },
        { status: 400 },
      );
    }
    const body = parsedBody as StartScenarioBody;
    if (body.hostId !== undefined && typeof body.hostId !== "string") {
      return jsonResponse(
        { error: "hostId must be a string" },
        { status: 400 },
      );
    }
    if (
      body.admissionMode !== undefined &&
      body.admissionMode !== "benchmark"
    ) {
      return jsonResponse(
        { error: 'admissionMode must be "benchmark"' },
        { status: 400 },
      );
    }
    hostId = typeof body.hostId === "string" ? body.hostId.trim() : undefined;
    if (body.hostId !== undefined && !hostId) {
      return jsonResponse(
        { error: "hostId must not be empty" },
        { status: 400 },
      );
    }
    admissionMode =
      body.admissionMode === "benchmark" ? "benchmark" : undefined;
    if (admissionMode && !hostId) {
      return jsonResponse(
        { error: "benchmark admission requires hostId" },
        { status: 400 },
      );
    }
    if ((hostId || admissionMode) && !authz.context.isAdmin) {
      return jsonResponse({ error: "admin required" }, { status: 403 });
    }
  }

  try {
    const result = await startScenarioRunForUser({
      scenarioId,
      userId: authz.context.userId,
      ...(hostId ? { hostId } : {}),
      ...(admissionMode ? { admissionMode } : {}),
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to start scenario");
    return jsonResponse(body, { status });
  }
};
