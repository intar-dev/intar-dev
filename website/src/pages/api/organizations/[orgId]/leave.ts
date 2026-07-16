import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { leaveOrganization } from "@/lib/organizations";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  if (!organizationId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    await leaveOrganization({
      organizationId,
      userId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to leave organization",
    );
    return jsonResponse(body, { status });
  }
};
