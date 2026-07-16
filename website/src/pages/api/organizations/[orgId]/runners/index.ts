import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireUserContext,
  resolveRequestOrigin,
} from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  createOrRotateOrganizationRunner,
  listOrganizationRunners,
} from "@/lib/organization-runners";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

async function organizationIdFor(key: string): Promise<string> {
  const organizationId = await resolveOrganizationId(key);
  if (!organizationId) throw new Error("organization not found");
  return organizationId;
}

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    const organizationId = await organizationIdFor(params.orgId ?? "");
    const runners = await listOrganizationRunners({
      organizationId,
      userId: authz.context.userId,
    });
    return jsonResponse({ runners });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list organization runners",
      error instanceof Error && error.message === "organization not found"
        ? 404
        : 500,
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    runnerId?: unknown;
    role?: unknown;
  };
  if (body.role !== undefined && body.role !== "agent") {
    return jsonResponse(
      { error: "organizations can only register scenario runners" },
      { status: 400 },
    );
  }

  try {
    const organizationId = await organizationIdFor(params.orgId ?? "");
    const result = await createOrRotateOrganizationRunner({
      organizationId,
      actorUserId: authz.context.userId,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.runnerId === "string"
        ? { runnerId: body.runnerId.trim() }
        : {}),
      baseUrl: resolveRequestOrigin(request),
    });
    return jsonResponse({ ...result, host: result.runner }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to create organization runner",
      error instanceof Error && error.message === "organization not found"
        ? 404
        : 500,
    );
    return jsonResponse(errorBody, { status });
  }
};
