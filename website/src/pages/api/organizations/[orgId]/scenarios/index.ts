import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listScenarioCatalogForUser } from "@/lib/scenario-runs";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
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
    });
    const scenarios = await listScenarioCatalogForUser(
      authz.context.userId,
      organizationId,
    );
    return jsonResponse({ scenarios });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load organization scenarios",
    );
    return jsonResponse(body, { status });
  }
};
