import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { requireWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import {
  createWorkshopRegistryToken,
  listWorkshopRegistryTokens,
} from "@/lib/workshops/registry-tokens";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    return jsonResponse({
      tokens: await listWorkshopRegistryTokens({
        organizationId,
        actorUserId: authz.context.userId,
      }),
    });
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to list workshop registry tokens",
    );
    return jsonResponse(response.body, { status: response.status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    const expiresAt =
      typeof body?.expiresAt === "number" ? body.expiresAt : undefined;
    const token = await createWorkshopRegistryToken({
      organizationId,
      actorUserId: authz.context.userId,
      name: typeof body?.name === "string" ? body.name : "Workshop publisher",
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return jsonResponse(token, { status: 201 });
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to create workshop registry token",
    );
    return jsonResponse(response.body, { status: response.status });
  }
};
