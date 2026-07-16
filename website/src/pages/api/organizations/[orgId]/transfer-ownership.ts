import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { transferOrganizationOwnership } from "@/lib/organizations";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as {
    memberId?: unknown;
  } | null;
  const memberId =
    typeof body?.memberId === "string" ? body.memberId.trim() : "";
  if (!organizationId || !memberId) {
    return jsonResponse(
      { error: "orgId and memberId are required" },
      { status: 400 },
    );
  }

  try {
    await transferOrganizationOwnership({
      organizationId,
      actorUserId: authz.context.userId,
      targetMemberId: memberId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to transfer ownership",
    );
    return jsonResponse(errorBody, { status });
  }
};
