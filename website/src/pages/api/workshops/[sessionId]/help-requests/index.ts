import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { createWorkshopHelpRequest } from "@/lib/workshops/assistance";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import { getWorkshopSessionProjection } from "@/lib/workshops/projection";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as {
    message?: unknown;
    moduleId?: unknown;
  } | null;
  if (!sessionId) {
    return jsonResponse({ error: "sessionId is required" }, { status: 400 });
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    await createWorkshopHelpRequest({
      sessionId,
      userId: authz.context.userId,
      message: typeof body?.message === "string" ? body.message : "",
      moduleId:
        typeof body?.moduleId === "string" ? body.moduleId : null,
    });
    return jsonResponse(
      await getWorkshopSessionProjection({
        sessionId,
        userId: authz.context.userId,
      }),
      { status: 201 },
    );
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to create workshop help request",
    );
    return jsonResponse(errorBody, { status });
  }
};
