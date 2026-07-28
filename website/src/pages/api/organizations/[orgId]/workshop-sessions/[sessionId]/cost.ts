import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { workshopSessions } from "@/db/schema";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";
import { getWorkshopCostProjection } from "@/lib/workshops/cost-storage";
import { requireWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { refreshWorkshopSessionProviderPreflight } from "@/lib/workshops/session-provider";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  return handleWorkshopCostRequest(request, params, false);
};

// Kept as a compatibility alias; the documented refresh endpoint is
// /cost/refresh and delegates to the same authorization and preflight path.
export const POST: APIRoute = async ({ request, params }) => {
  return handleWorkshopCostRequest(request, params, true);
};

export async function handleWorkshopCostRequest(
  request: Request,
  params: Record<string, string | undefined>,
  refresh: boolean,
): Promise<Response> {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const sessionId = params.sessionId?.trim() ?? "";
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    await requireOrganizationRole({
      organizationId,
      userId: authz.context.userId,
      admin: true,
    });
    const session = await drizzle(env.DB)
      .select({ id: workshopSessions.id })
      .from(workshopSessions)
      .where(
        and(
          eq(workshopSessions.id, sessionId),
          eq(workshopSessions.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!session[0]) {
      throw appError(
        404,
        "workshop_session_not_found",
        "workshop session not found",
      );
    }
    if (refresh) {
      await refreshWorkshopSessionProviderPreflight({
        sessionId,
        actorUserId: authz.context.userId,
        trigger: "admin_refresh",
      });
    }
    return jsonResponse(await getWorkshopCostProjection({ sessionId }));
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      refresh
        ? "failed to refresh workshop cost forecast"
        : "failed to load workshop cost forecast",
    );
    return jsonResponse(body, { status });
  }
}
