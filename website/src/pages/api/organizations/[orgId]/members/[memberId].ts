import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  removeOrganizationMember,
  updateOrganizationMemberRole,
} from "@/lib/organizations";

export const prerender = false;

export const PATCH: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  const memberId = params.memberId?.trim() ?? "";
  if (!organizationId || !memberId) {
    return jsonResponse(
      { error: "orgId and memberId are required" },
      { status: 400 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    role?: unknown;
  } | null;
  if (body?.role !== "admin" && body?.role !== "member") {
    return jsonResponse(
      { error: "role must be admin or member" },
      { status: 400 },
    );
  }

  try {
    await updateOrganizationMemberRole({
      organizationId,
      actorUserId: authz.context.userId,
      memberId,
      role: body.role,
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
  const organizationId = params.orgId?.trim() ?? "";
  const memberId = params.memberId?.trim() ?? "";
  if (!organizationId || !memberId) {
    return jsonResponse(
      { error: "orgId and memberId are required" },
      { status: 400 },
    );
  }

  try {
    await removeOrganizationMember({
      organizationId,
      memberId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to remove member");
    return jsonResponse(body, { status });
  }
};
