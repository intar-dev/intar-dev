import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { queueDraftBuild } from "@/lib/authoring-build";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    scenarioId?: unknown;
    contentHash?: unknown;
    imageArch?: unknown;
  } | null;

  try {
    await requireOrganizationRole({
      organizationId,
      userId: authz.context.userId,
      admin: true,
    });
    const result = await queueDraftBuild({
      scenarioId:
        typeof body?.scenarioId === "string" ? body.scenarioId.trim() : "",
      contentHash:
        typeof body?.contentHash === "string" ? body.contentHash : "",
      imageArch: typeof body?.imageArch === "string" ? body.imageArch : "",
      organizationId,
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to queue organization scenario build",
    );
    return jsonResponse(errorBody, { status });
  }
};
