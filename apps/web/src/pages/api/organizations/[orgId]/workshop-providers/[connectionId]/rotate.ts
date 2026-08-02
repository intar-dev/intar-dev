import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { readProviderRequestBody } from "@/lib/workshops/provider-api";
import { rotateProviderCredential } from "@/lib/workshops/provider-connections";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse(
      { error: "organization not found", code: "organization_not_found" },
      { status: 404 },
    );
  }
  try {
    const body = await readProviderRequestBody(request);
    return jsonResponse(
      await rotateProviderCredential({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
        credential: typeof body.credential === "string" ? body.credential : "",
      }),
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to rotate provider credential",
    );
    return jsonResponse(body, { status });
  }
};
