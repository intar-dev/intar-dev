import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { closeWorkshopHelpRequest } from "@/lib/workshops/assistance";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import { getWorkshopSessionProjection } from "@/lib/workshops/projection";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  const requestId = params.requestId?.trim() ?? "";
  if (!sessionId || !requestId) {
    return jsonResponse(
      { error: "sessionId and requestId are required" },
      { status: 400 },
    );
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    await closeWorkshopHelpRequest({
      sessionId,
      helpRequestId: requestId,
      actorUserId: authz.context.userId,
      action: "cancel",
    });
    return jsonResponse(
      await getWorkshopSessionProjection({
        sessionId,
        userId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to close workshop help request",
    );
    return jsonResponse(body, { status });
  }
};
