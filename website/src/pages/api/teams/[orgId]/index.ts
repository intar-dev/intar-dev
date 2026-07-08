import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { deleteTeam, getTeamDetail, updateTeamName } from "@/lib/teams";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const team = await getTeamDetail({
      organizationId: orgId,
      userId: authz.context.userId,
    });
    return jsonResponse({ team });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load team");
    return jsonResponse(body, { status });
  }
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name = typeof body?.name === "string" ? body.name : "";

  try {
    const team = await updateTeamName({
      organizationId: orgId,
      actorUserId: authz.context.userId,
      name,
    });
    return jsonResponse({ team });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to rename team",
    );
    return jsonResponse(errorBody, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    await deleteTeam({
      organizationId: orgId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to delete team");
    return jsonResponse(body, { status });
  }
};
