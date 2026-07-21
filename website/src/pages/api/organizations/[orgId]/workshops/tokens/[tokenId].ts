import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { requireWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { revokeWorkshopRegistryToken } from "@/lib/workshops/registry-tokens";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    await revokeWorkshopRegistryToken({
      organizationId,
      actorUserId: authz.context.userId,
      tokenId: params.tokenId ?? "",
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to revoke workshop registry token",
    );
    return jsonResponse(response.body, { status: response.status });
  }
};
