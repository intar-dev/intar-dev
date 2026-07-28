import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { rotateHetznerCredential } from "@/lib/workshops/provider-connections";

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
  } | null;
  try {
    return jsonResponse(
      await rotateHetznerCredential({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
        token: typeof body?.token === "string" ? body.token : "",
      }),
    );
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to rotate Hetzner credential",
    );
    return jsonResponse(errorBody, { status });
  }
};
