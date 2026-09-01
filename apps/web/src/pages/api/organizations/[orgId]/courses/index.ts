import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";
import { listCourseCatalogForUser } from "@/lib/scenario-course-catalogs";
import { loadScenarioCapacityPressure } from "@/lib/scenario-runs/start";

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
    const catalog = await listCourseCatalogForUser({
      db: drizzle(env.DB),
      userId: authz.context.userId,
      organizationId,
      capacityPressure: await loadScenarioCapacityPressure(organizationId),
      allowSequenceBypass: authz.context.isAdmin,
    });
    return jsonResponse(catalog);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load organization courses",
    );
    return jsonResponse(body, { status });
  }
};
