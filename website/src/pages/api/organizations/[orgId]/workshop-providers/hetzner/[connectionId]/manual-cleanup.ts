import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { acknowledgeHetznerManualCleanup } from "@/lib/workshops/provider-connections";

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
      await acknowledgeHetznerManualCleanup({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to acknowledge manual Hetzner cleanup",
    );
    return jsonResponse(body, { status });
  }
};
