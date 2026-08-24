import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { loadEnabledScenarioForUser } from "@/lib/scenario-runs";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  const organizationKey =
    new URL(request.url).searchParams.get("organizationId")?.trim() || null;
  const organizationId = organizationKey
    ? await resolveOrganizationId(organizationKey)
    : null;
  if (
    (organizationKey && !organizationId) ||
    (organizationId && !authz.context.organizationIds.includes(organizationId))
  ) {
    return jsonResponse({ error: "scenario not found" }, { status: 404 });
  }

  const scenario = await loadEnabledScenarioForUser({
    scenarioId,
    userId: authz.context.userId,
    organizationId,
  });
  if (!scenario) {
    return jsonResponse({ error: "scenario not found" }, { status: 404 });
  }

  return jsonResponse({ scenario });
};
