import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import { getWorkshopSessionProjection } from "@/lib/workshops/projection";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  if (!sessionId) {
    return jsonResponse({ error: "sessionId is required" }, { status: 400 });
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    const view = new URL(request.url).searchParams.get("view");
    return jsonResponse(
      await getWorkshopSessionProjection({
        sessionId,
        userId: authz.context.userId,
        view: view === "projector" ? "projector" : "room",
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load workshop session",
    );
    return jsonResponse(body, { status });
  }
};
