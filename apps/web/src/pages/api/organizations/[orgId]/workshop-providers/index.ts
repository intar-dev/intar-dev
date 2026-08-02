import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { readProviderRequestBody } from "@/lib/workshops/provider-api";
import {
  connectProviderProject,
  listProviderConnections,
  type DirectCloudProviderKind,
} from "@/lib/workshops/provider-connections";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) return organizationNotFound();
  try {
    return jsonResponse(
      await listProviderConnections({
        organizationId,
        actorUserId: authz.context.userId,
      }),
    );
  } catch (error) {
    return providerError(error, "failed to list provider connections");
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) return organizationNotFound();
  try {
    const body = await readProviderRequestBody(request);
    const providerKind = directProviderKind(body.providerKind);
    const approvedLocations = optionalStringArray(
      body,
      "approvedLocations",
    );
    const maxConcurrentAllocations = optionalNumber(
      body,
      "maxConcurrentAllocations",
    );
    const maxSessionCostNanos = optionalNullableNumber(
      body,
      "maxSessionCostNanos",
    );
    const connection = await connectProviderProject({
      organizationId,
      actorUserId: authz.context.userId,
      providerKind,
      credential: typeof body.credential === "string" ? body.credential : "",
      ...(typeof body.displayName === "string"
        ? { displayName: body.displayName }
        : {}),
      ...(typeof body.externalProjectId === "string"
        ? { externalProjectId: body.externalProjectId }
        : {}),
      ...(approvedLocations === undefined ? {} : { approvedLocations }),
      ...(maxConcurrentAllocations === undefined
        ? {}
        : { maxConcurrentAllocations }),
      ...(maxSessionCostNanos === undefined ? {} : { maxSessionCostNanos }),
    });
    return jsonResponse(connection, { status: 201 });
  } catch (error) {
    return providerError(error, "failed to connect provider project");
  }
};

function directProviderKind(value: unknown): DirectCloudProviderKind {
  if (value !== "hetzner_cloud" && value !== "gcp_compute") {
    throw appError(
      400,
      "runtime_provider_invalid",
      "providerKind must be hetzner_cloud or gcp_compute",
    );
  }
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidField(key);
  }
  return value;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "number") throw invalidField(key);
  return value;
}

function optionalNullableNumber(
  body: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value !== null && typeof value !== "number") throw invalidField(key);
  return value;
}

function invalidField(key: string) {
  return appError(
    400,
    "provider_request_invalid",
    `${key} has an invalid value`,
  );
}

function organizationNotFound() {
  return jsonResponse(
    { error: "organization not found", code: "organization_not_found" },
    { status: 404 },
  );
}

function providerError(error: unknown, fallback: string) {
  const { status, body } = toErrorResponse(error, fallback);
  return jsonResponse(body, { status });
}
