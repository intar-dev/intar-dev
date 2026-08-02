import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { overrideWorkshopSessionCostCeiling } from "@/lib/workshops/cost-override";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  try {
    return jsonResponse(
      await overrideWorkshopSessionCostCeiling({
        organizationId,
        sessionId: params.sessionId ?? "",
        actorUserId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to override workshop cost ceiling",
    );
    return jsonResponse(body, { status });
  }
};
