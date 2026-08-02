import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listWorkshopArtifactsForOwner } from "@/lib/workshops/artifacts";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";

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
    return jsonResponse(
      await listWorkshopArtifactsForOwner({
        sessionId,
        userId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load workshop artifacts",
    );
    return jsonResponse(body, { status });
  }
};
