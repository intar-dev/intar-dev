import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { removeTeamMember, updateTeamMemberRole } from "@/lib/teams";

export const prerender = false;

export const PATCH: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  const memberId = params.memberId?.trim() ?? "";
  if (!orgId || !memberId) {
    return jsonResponse(
      { error: "orgId and memberId are required" },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    role?: unknown;
  } | null;
  const role = body?.role;
  if (role !== "admin" && role !== "member") {
    return jsonResponse(
      { error: "role must be admin or member" },
      { status: 400 },
    );
  }

  try {
    await updateTeamMemberRole({
      organizationId: orgId,
      actorUserId: authz.context.userId,
      memberId,
      role,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to change member role",
    );
    return jsonResponse(errorBody, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  const memberId = params.memberId?.trim() ?? "";
  if (!orgId || !memberId) {
    return jsonResponse(
      { error: "orgId and memberId are required" },
      { status: 400 },
    );
  }

  try {
    await removeTeamMember({
      organizationId: orgId,
      memberId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to remove member");
    return jsonResponse(body, { status });
  }
};
