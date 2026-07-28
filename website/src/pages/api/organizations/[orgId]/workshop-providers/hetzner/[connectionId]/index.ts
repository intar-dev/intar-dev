import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import {
  disconnectHetznerProject,
  updateHetznerProviderGuardrails,
} from "@/lib/workshops/provider-connections";

export const prerender = false;

export const PATCH: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    approvedLocations?: unknown;
    maxConcurrentServers?: unknown;
    maxSessionGrossMicros?: unknown;
  } | null;
  try {
    return jsonResponse(
      await updateHetznerProviderGuardrails({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
        ...(Array.isArray(body?.approvedLocations) &&
        body.approvedLocations.every((entry) => typeof entry === "string")
          ? { approvedLocations: body.approvedLocations as string[] }
          : {}),
        ...(typeof body?.maxConcurrentServers === "number"
          ? { maxConcurrentServers: body.maxConcurrentServers }
          : {}),
        ...(body?.maxSessionGrossMicros === null ||
        typeof body?.maxSessionGrossMicros === "number"
          ? { maxSessionGrossMicros: body.maxSessionGrossMicros }
          : {}),
      }),
    );
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to update Hetzner provider guardrails",
    );
    return jsonResponse(errorBody, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  try {
    return jsonResponse(
      await disconnectHetznerProject({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to disconnect Hetzner project",
    );
    return jsonResponse(body, { status });
  }
};
