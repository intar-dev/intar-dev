import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import {
  connectHetznerProject,
  listHetznerProviderConnections,
} from "@/lib/workshops/provider-connections";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  try {
    return jsonResponse(
      await listHetznerProviderConnections({
        organizationId,
        actorUserId: authz.context.userId,
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list provider connections",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    displayName?: unknown;
    approvedLocations?: unknown;
    maxConcurrentServers?: unknown;
    maxSessionGrossMicros?: unknown;
  } | null;
  try {
    const connection = await connectHetznerProject({
      organizationId,
      actorUserId: authz.context.userId,
      token: typeof body?.token === "string" ? body.token : "",
      ...(typeof body?.displayName === "string"
        ? { displayName: body.displayName }
        : {}),
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
    });
    return jsonResponse(connection, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to connect Hetzner project",
    );
    return jsonResponse(errorBody, { status });
  }
};
