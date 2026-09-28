import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import {
  isOrganizationAdminRole,
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";
import {
  changeScenarioSource,
  refuseScenarioSourceWrite,
  scenarioSourceCard,
  scenarioSourceScope,
} from "@/lib/scenario-sources";

export const prerender = false;

// Only owners and admins learn anything about the binding; members and
// everyone else get the same 404 as a missing organization.
async function authorize(request: Request, organizationKey: string) {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz;
  const organizationId = await resolveOrganizationId(organizationKey);
  if (
    !organizationId ||
    !isOrganizationAdminRole(
      await requireOrganizationRole({
        organizationId,
        userId: authz.context.userId,
      }),
    )
  ) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  return {
    ok: true as const,
    context: authz.context,
    scope: scenarioSourceScope(organizationId),
  };
}

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    return jsonResponse(await scenarioSourceCard(access.scope));
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load the scenario source",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const startedAt = Date.now();
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    const refused = await refuseScenarioSourceWrite(request, access.context);
    if (refused) return refused;
    const source = await changeScenarioSource({
      scope: access.scope,
      actorUserId: access.context.userId,
      body: await request.json().catch(() => null),
      startedAt,
    });
    return jsonResponse({ source });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to change the scenario source",
    );
    return jsonResponse(body, { status });
  }
};
