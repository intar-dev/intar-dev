import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { changeScenarioSource, refuseScenarioSourceWrite, scenarioSourceCard, scenarioSourceScope } from "@/lib/scenario-sources";

export const prerender = false;

/**
 * An organization's scenario source, for a platform administrator who is
 * not one of its own (#472). Its own owners and admins run it at
 * `/api/organizations/[orgId]/scenario-source`; a flag that let them widen
 * it revokes nothing when it is turned off, so this is how the platform
 * steps a source back: images to the builder, runners to GitHub-hosted,
 * pull mode, and forgetting an image. None of it needs a flag.
 *
 * A step back holds only as far as the organization cannot take it again:
 * turn its flag off first. The pipeline has a flag of its own; the runners and push mode need only the flag that lets an
 * organization connect at all, so its administrators can undo those.
 */
async function scopeOf(request: Request, organizationKey: string) {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz;
  const organizationId = await resolveOrganizationId(organizationKey);
  if (!organizationId) throw appError(404, "organization_not_found", "organization not found");
  return { ok: true as const, context: authz.context, scope: scenarioSourceScope(organizationId) };
}

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const access = await scopeOf(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    return jsonResponse(await scenarioSourceCard(access.scope));
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load the scenario source");
    return jsonResponse(body, { status });
  }
};

// Every write rechecks in its statement that the caller is still an active
// platform admin.
export const POST: APIRoute = async ({ request, params }) => {
  const startedAt = Date.now();
  try {
    const access = await scopeOf(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    const refused = await refuseScenarioSourceWrite(request, access.context);
    if (refused) return refused;
    const source = await changeScenarioSource({
      scope: access.scope,
      actorUserId: access.context.userId,
      body: await request.json().catch(() => null),
      startedAt,
      asPlatform: true,
    });
    return jsonResponse({ source });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to change the scenario source");
    return jsonResponse(body, { status });
  }
};
