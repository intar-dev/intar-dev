import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { decideAccessRequest } from "@/lib/access-requests";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const requestId = params.requestId?.trim() ?? "";
  if (!requestId) {
    return jsonResponse({ error: "requestId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    decision?: unknown;
  } | null;
  const decision = body?.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return jsonResponse(
      { error: "decision must be 'approved' or 'rejected'" },
      { status: 400 },
    );
  }

  try {
    const updated = await decideAccessRequest({
      id: requestId,
      decision,
      adminUserId: authz.context.userId,
    });
    return jsonResponse({ request: updated });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to decide access request",
    );
    return jsonResponse(errorBody, { status });
  }
};
