import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { transferTeamOwnership } from "@/lib/teams";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    memberId?: unknown;
  } | null;
  const memberId = typeof body?.memberId === "string" ? body.memberId.trim() : "";
  if (!memberId) {
    return jsonResponse({ error: "memberId is required" }, { status: 400 });
  }

  try {
    await transferTeamOwnership({
      organizationId: orgId,
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
