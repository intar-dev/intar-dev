import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { listEnabledScenariosForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarios = await listEnabledScenariosForUser();
  return jsonResponse({ scenarios });
};
