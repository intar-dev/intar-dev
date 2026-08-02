import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import { recordWorkshopPresence } from "@/lib/workshops/presence";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  if (!sessionId) {
    return jsonResponse({ error: "sessionId is required" }, { status: 400 });
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    return jsonResponse(
      await recordWorkshopPresence({
        sessionId,
        userId: authz.context.userId,
      }),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to record workshop presence",
    );
    return jsonResponse(body, { status });
  }
};
