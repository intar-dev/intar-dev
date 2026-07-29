import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { rebindHetznerProject } from "@/lib/workshops/provider-connections";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    approvedLocations?: unknown;
    maxConcurrentServers?: unknown;
    maxSessionGrossMicros?: unknown;
  } | null;
  try {
    return jsonResponse(
      await rebindHetznerProject({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
        token: typeof body?.token === "string" ? body.token : "",
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
      "failed to rebind Hetzner project",
    );
    return jsonResponse(errorBody, { status });
  }
};
