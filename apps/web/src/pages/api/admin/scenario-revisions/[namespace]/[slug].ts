import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { listAdministeredScenarios } from "@/lib/scenario-revisions";

export const prerender = false;

const scenarioIdOf = (params: Record<string, string | undefined>) => `${params.namespace ?? ""}/${params.slug ?? ""}`;

async function readScenario(userId: string, scenarioId: string) {
  const [scenario] = await listAdministeredScenarios(userId, scenarioId);
  if (!scenario) throw appError(404, "scenario_not_found", "scenario not found");
  return scenario;
}

// Only a read: no administrator action on a revision exists (#494). Checking
// and putting labs live, their snapshot starts and the course catalog are the
// scope's source's job, and a bad lab is reverted in its repository. A POST
// finds no handler and gets Astro's 404.
export const GET: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireUserContext(request);
    if (!authz.ok) return authz.response;
    return jsonResponse({ scenario: await readScenario(authz.context.userId, scenarioIdOf(params)) });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load the scenario");
    return jsonResponse(body, { status });
  }
};
