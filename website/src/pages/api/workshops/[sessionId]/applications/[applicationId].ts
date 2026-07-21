import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { issueWorkshopWorkspaceApplication } from "@/lib/workshops/applications";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  const applicationId = params.applicationId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const workspaceId =
    typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!sessionId || !applicationId || !workspaceId) {
    return jsonResponse(
      { error: "sessionId, applicationId, and workspaceId are required" },
      { status: 400 },
    );
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    return jsonResponse(
      await issueWorkshopWorkspaceApplication({
        sessionId,
        workspaceId,
        applicationId,
        actorUserId: authz.context.userId,
      }),
      {
        headers: {
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to open workshop application",
    );
    return jsonResponse(response.body, { status: response.status });
  }
};
