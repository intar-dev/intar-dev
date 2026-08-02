import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireUserContext,
  resolveRequestOrigin,
} from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { verifyOrganizationOidcDomain } from "@/lib/organization-oidc";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }

  try {
    await requireOrganizationRole({
      organizationId,
      userId: authz.context.userId,
      admin: true,
    });
    const provider = await verifyOrganizationOidcDomain({
      organizationId,
      baseUrl: resolveRequestOrigin(request),
    });
    return jsonResponse({ provider });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to verify OIDC domain",
    );
    return jsonResponse(body, { status });
  }
};
