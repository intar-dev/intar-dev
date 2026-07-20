import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { performWorkshopSessionAction } from "@/lib/workshops/actions";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import { getWorkshopSessionProjection } from "@/lib/workshops/projection";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  if (!sessionId || !action) {
    return jsonResponse(
      { error: "sessionId and action are required" },
      { status: 400 },
    );
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    await performWorkshopSessionAction({
      sessionId,
      actorUserId: authz.context.userId,
      action,
      ...(typeof body?.version === "number"
        ? { expectedVersion: body.version }
        : {}),
      payload: body ?? {},
    });
    return jsonResponse(
      await getWorkshopSessionProjection({
        sessionId,
        userId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to update workshop session",
    );
    return jsonResponse(errorBody, { status });
  }
};
