import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { acknowledgeProviderManualCleanup } from "@/lib/workshops/provider-connections";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse(
      { error: "organization not found", code: "organization_not_found" },
      { status: 404 },
    );
  }
  try {
    return jsonResponse(
      await acknowledgeProviderManualCleanup({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to acknowledge provider cleanup",
    );
    return jsonResponse(body, { status });
  }
};
