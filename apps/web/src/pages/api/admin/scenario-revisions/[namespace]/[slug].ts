import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { assertScenarioAdmin, listAdministeredScenarios, moveLiveRevision } from "@/lib/scenario-revisions";
import { beginVerifyRun } from "@/lib/scenario-runs/revision-begin";
import { refuseScenarioSourceWrite } from "@/lib/scenario-sources";

export const prerender = false;

const scenarioIdOf = (params: Record<string, string | undefined>) => `${params.namespace ?? ""}/${params.slug ?? ""}`;

async function readScenario(userId: string, scenarioId: string) {
  const [scenario] = await listAdministeredScenarios(userId, scenarioId);
  if (!scenario) throw appError(404, "scenario_not_found", "scenario not found");
  return scenario;
}

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

/**
 * `{action: "verify", rev}` starts a verify run of the candidate;
 * `{action: "promote" | "rollback", rev, liveRev}` moves the live revision
 * from `liveRev`, the one the caller saw. Only the scenario's scope admins.
 */
export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireUserContext(request);
    if (!authz.ok) return authz.response;
    const scenarioId = scenarioIdOf(params);
    await assertScenarioAdmin(authz.context.userId, scenarioId);
    const refused = await refuseScenarioSourceWrite(request, authz.context);
    if (refused) return refused;
    const body = (await request.json().catch(() => null)) as { action?: unknown; rev?: unknown; liveRev?: unknown } | null;
    const rev = typeof body?.rev === "string" ? body.rev : "";
    if (!rev) throw appError(400, "invalid_request", "rev is required");
    if (body?.action === "verify") {
      const run = await beginVerifyRun({ scenarioId, rev });
      return jsonResponse({ runId: run.runId, scenario: await readScenario(authz.context.userId, scenarioId) }, { status: 202 });
    }
    if (body?.action !== "promote" && body?.action !== "rollback") {
      throw appError(400, "invalid_request", "action is verify, promote or rollback");
    }
    if (body.liveRev !== null && typeof body.liveRev !== "string") {
      throw appError(400, "invalid_request", "liveRev is the live revision you saw, or null");
    }
    await moveLiveRevision({ scenarioId, rev, liveRev: body.liveRev, kind: body.action, actorUserId: authz.context.userId });
    return jsonResponse({ scenario: await readScenario(authz.context.userId, scenarioId) });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to change the scenario");
    return jsonResponse(body, { status });
  }
};
