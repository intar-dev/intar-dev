import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  assignScenarioToTeam,
  listTeamAssignments,
} from "@/lib/assignments";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const assignments = await listTeamAssignments({
      organizationId: orgId,
      userId: authz.context.userId,
    });
    return jsonResponse({ assignments });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list assignments",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    scenarioId?: unknown;
  } | null;
  const scenarioId =
    typeof body?.scenarioId === "string" ? body.scenarioId.trim() : "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }

  try {
    const assignment = await assignScenarioToTeam({
      organizationId: orgId,
      scenarioId,
      actorUserId: authz.context.userId,
    });
    return jsonResponse({ assignment }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to assign scenario",
    );
    return jsonResponse(errorBody, { status });
  }
};
