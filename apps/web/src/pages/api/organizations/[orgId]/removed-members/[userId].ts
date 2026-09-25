import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { restoreOrganizationMember } from "@/lib/organizations";

export const prerender = false;

// Restores a removed person's access through the organization's identity
// provider. They rejoin on their next organization sign-in.
export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  const userId = params.userId?.trim() ?? "";
  if (!organizationId || !userId) {
    return jsonResponse(
      { error: "orgId and userId are required" },
      { status: 400 },
    );
  }

  try {
    await restoreOrganizationMember({
      organizationId,
      userId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to restore member");
    return jsonResponse(body, { status });
  }
};
