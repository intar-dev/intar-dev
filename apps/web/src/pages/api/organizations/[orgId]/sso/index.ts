import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireUserContext,
  resolveRequestOrigin,
} from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  deleteOrganizationOidc,
  getOrganizationOidc,
  registerOrganizationOidc,
} from "@/lib/organization-oidc";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";

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
  return { ok: true as const, organizationId, context: authz.context };
}

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    const provider = await getOrganizationOidc({
      organizationId: access.organizationId,
      baseUrl: resolveRequestOrigin(request),
    });
    return jsonResponse({ provider });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load organization OIDC provider",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    const body = (await request.json().catch(() => null)) as {
      issuer?: unknown;
      domain?: unknown;
      clientId?: unknown;
      clientSecret?: unknown;
    } | null;
    const provider = await registerOrganizationOidc({
      organizationId: access.organizationId,
      actorUserId: access.context.userId,
      issuer: typeof body?.issuer === "string" ? body.issuer : "",
      domain: typeof body?.domain === "string" ? body.domain : "",
      clientId: typeof body?.clientId === "string" ? body.clientId : "",
      clientSecret:
        typeof body?.clientSecret === "string" ? body.clientSecret : "",
      baseUrl: resolveRequestOrigin(request),
    });
    return jsonResponse({ provider }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to register organization OIDC provider",
    );
    return jsonResponse(body, { status });
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const access = await authorize(request, params.orgId ?? "");
    if (!access.ok) return access.response;
    await deleteOrganizationOidc({ organizationId: access.organizationId });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to delete organization OIDC provider",
    );
    return jsonResponse(body, { status });
  }
};
