import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  getOrganizationDetail,
  requireOrganizationRole,
} from "@/lib/organizations";
import {
  listScenarioSources,
  namespaceOrganizationScenarioSource,
  saveScenarioSource,
} from "@/lib/scenario-sources";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const organization = await getOrganizationDetail({
      organizationKey: params.orgId ?? "",
      userId: authz.context.userId,
    });
    await requireOrganizationRole({
      organizationId: organization.id,
      userId: authz.context.userId,
      admin: true,
    });
    const sources = await listScenarioSources(organization.id);
    return jsonResponse({ sources });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list organization scenario sources",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const body = (await request.json().catch(() => null)) as {
    scenarioId?: unknown;
    hcl?: unknown;
  } | null;

  try {
    const organization = await getOrganizationDetail({
      organizationKey: params.orgId ?? "",
      userId: authz.context.userId,
    });
    await requireOrganizationRole({
      organizationId: organization.id,
      userId: authz.context.userId,
      admin: true,
    });
    const namespaced = namespaceOrganizationScenarioSource({
      organizationSlug: organization.slug,
      localScenarioId:
        typeof body?.scenarioId === "string" ? body.scenarioId : "",
      hcl: typeof body?.hcl === "string" ? body.hcl : "",
    });
    const source = await saveScenarioSource({
      ...namespaced,
      organizationId: organization.id,
      userId: authz.context.userId,
    });
    return jsonResponse({ source }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to save organization scenario source",
    );
    return jsonResponse(errorBody, { status });
  }
};
