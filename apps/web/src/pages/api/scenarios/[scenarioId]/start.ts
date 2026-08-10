import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { startScenarioRunForUser } from "@/lib/scenario-runs";

export const prerender = false;

interface StartScenarioBody {
  hostId?: unknown;
  organizationId?: unknown;
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
  let organizationId: string | null = null;
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
      body.organizationId !== undefined &&
      body.organizationId !== null &&
      typeof body.organizationId !== "string"
    ) {
      return jsonResponse(
        { error: "organizationId must be a string" },
        { status: 400 },
      );
    }
    organizationId =
      typeof body.organizationId === "string"
        ? body.organizationId.trim() || null
        : null;
    if (
      organizationId &&
      !authz.context.organizationIds.includes(organizationId)
    ) {
      return jsonResponse({ error: "scenario not found" }, { status: 404 });
    }
    hostId = typeof body.hostId === "string" ? body.hostId.trim() : undefined;
    if (body.hostId !== undefined && !hostId) {
      return jsonResponse(
        { error: "hostId must not be empty" },
        { status: 400 },
      );
    }
    if (hostId && !authz.context.isAdmin) {
      return jsonResponse({ error: "admin required" }, { status: 403 });
    }
  }

  try {
    const result = await startScenarioRunForUser({
      scenarioId,
      userId: authz.context.userId,
      betaAdmission: authz.context.betaAdmission,
      ...(organizationId ? { organizationId } : {}),
      ...(hostId ? { hostId } : {}),
    });
    return jsonResponse(result, {
      status: 202,
      headers: {
        Location: `/api/scenarios/runs/${result.runId}`,
        "Retry-After": "1",
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to start scenario");
    return jsonResponse(body, {
      status,
      ...(body.code === "boot_capacity_pending"
        ? { headers: { "Retry-After": "2" } }
        : {}),
    });
  }
};
