import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { loadPlayScenario } from "@/lib/play-scenarios";

export const prerender = false;

/**
 * A scenario's play page. Anyone may read its public fields; the briefing
 * and tags need sign-in. Every scenario that is not open to play answers the
 * same 404.
 */
export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  const scenario = await loadPlayScenario(env.DB, params.namespace ?? "", params.slug ?? "", authz.ok);
  if (!scenario) {
    return jsonResponse({ error: "scenario not found", code: "scenario_not_found" }, { status: 404 });
  }
  return jsonResponse({ scenario, signedIn: authz.ok });
};
