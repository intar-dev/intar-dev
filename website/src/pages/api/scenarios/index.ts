import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { listScenarioCatalogForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarios = await listScenarioCatalogForUser(authz.context.userId);
  return jsonResponse({ scenarios });
};
