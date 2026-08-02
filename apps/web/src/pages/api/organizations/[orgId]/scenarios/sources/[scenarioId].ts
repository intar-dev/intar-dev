import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";
import {
  deleteScenarioSource,
  getScenarioSource,
} from "@/lib/scenario-sources";

export const prerender = false;

async function authorize(request: Request, organizationKey: string) {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz;
  const organizationId = await resolveOrganizationId(organizationKey);
  if (!organizationId) {
    return {
      ok: false as const,
      response: jsonResponse(
        { error: "organization not found" },
        { status: 404 },
      ),
    };
  }
  await requireOrganizationRole({
    organizationId,
    userId: authz.context.userId,
    admin: true,
  });
  return { ok: true as const, organizationId };
}

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    const source = await getScenarioSource(
      params.scenarioId?.trim() ?? "",
      access.organizationId,
    );
    if (!source) {
      return jsonResponse({ error: "source not found" }, { status: 404 });
    }
    return jsonResponse({ source });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load organization scenario source",
    );
    return jsonResponse(body, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    await deleteScenarioSource(
      params.scenarioId?.trim() ?? "",
      access.organizationId,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to delete organization scenario source",
    );
    return jsonResponse(body, { status });
  }
};
