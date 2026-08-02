import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import {
  deleteOrganizationRunner,
  setOrganizationRunnerDisabled,
} from "@/lib/organization-runners";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

async function routeIds(params: Record<string, string | undefined>) {
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  const runnerId = params.runnerId?.trim() ?? "";
  if (!organizationId) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  if (!runnerId)
    throw appError(400, "runner_id_required", "runnerId is required");
  return { organizationId, runnerId };
}

export const PATCH: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const body = (await request.json().catch(() => null)) as {
    disabled?: unknown;
  } | null;
  if (typeof body?.disabled !== "boolean") {
    return jsonResponse(
      { error: "disabled must be a boolean" },
      { status: 400 },
    );
  }
  try {
    const ids = await routeIds(params);
    const runner = await setOrganizationRunnerDisabled({
      ...ids,
      actorUserId: authz.context.userId,
      disabled: body.disabled,
    });
    return jsonResponse({ runner });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to update organization runner",
    );
    return jsonResponse(errorBody, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    const ids = await routeIds(params);
    await deleteOrganizationRunner({
      ...ids,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to delete organization runner",
    );
    return jsonResponse(body, { status });
  }
};
