import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { deleteOrganizationScenario } from "@/lib/organization-scenarios";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  try {
    await deleteOrganizationScenario({
      organizationId,
      actorUserId: authz.context.userId,
      scenarioId: params.scenarioId?.trim() ?? "",
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to delete organization scenario",
    );
    return jsonResponse(body, { status });
  }
};
