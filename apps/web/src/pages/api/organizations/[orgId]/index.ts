import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  deleteOrganization,
  getOrganizationDetail,
  resolveOrganizationId,
  updateOrganizationName,
} from "@/lib/organizations";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationKey = params.orgId?.trim() ?? "";
  if (!organizationKey) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const organization = await getOrganizationDetail({
      organizationKey,
      userId: authz.context.userId,
    });
    return jsonResponse({ organization });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load organization",
    );
    return jsonResponse(body, { status });
  }
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;

  try {
    const organization = await updateOrganizationName({
      organizationId,
      actorUserId: authz.context.userId,
      name: typeof body?.name === "string" ? body.name : "",
    });
    return jsonResponse({ organization });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to rename organization",
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
    await deleteOrganization({
      organizationId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to delete organization",
    );
    return jsonResponse(body, { status });
  }
};
