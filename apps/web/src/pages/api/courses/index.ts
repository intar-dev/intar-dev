import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listCourseCatalogForUser } from "@/lib/scenario-course-catalogs";
import { loadScenarioCapacityPressure } from "@/lib/scenario-runs/start";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const catalog = await listCourseCatalogForUser({
      db: drizzle(env.DB),
      userId: authz.context.userId,
      organizationId: null,
      capacityPressure: await loadScenarioCapacityPressure(null),
      allowSequenceBypass: authz.context.isAdmin,
    });
    return jsonResponse(catalog);
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load courses");
    return jsonResponse(body, { status });
  }
};
