import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  assignScenarioToOrganization,
  listOrganizationAssignments,
} from "@/lib/assignments";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  if (!organizationId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    return jsonResponse({
      assignments: await listOrganizationAssignments({
        organizationId,
        userId: authz.context.userId,
      }),
    });
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
  const organizationId = params.orgId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as {
    scenarioId?: unknown;
  } | null;
  const scenarioId =
    typeof body?.scenarioId === "string" ? body.scenarioId.trim() : "";
  if (!organizationId || !scenarioId) {
    return jsonResponse(
      { error: "orgId and scenarioId are required" },
      { status: 400 },
    );
  }

  try {
    const assignment = await assignScenarioToOrganization({
      organizationId,
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
