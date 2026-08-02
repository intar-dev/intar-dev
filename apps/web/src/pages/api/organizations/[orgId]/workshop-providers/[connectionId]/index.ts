import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { readProviderRequestBody } from "@/lib/workshops/provider-api";
import {
  disconnectProviderConnection,
  updateProviderGuardrails,
} from "@/lib/workshops/provider-connections";

export const prerender = false;

export const PATCH: APIRoute = async ({ request, params }) => {
  const context = await requestContext(request, params.orgId);
  if (!context.ok) return context.response;
  try {
    const body = await readProviderRequestBody(request);
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
    return jsonResponse(
      await updateProviderGuardrails({
        organizationId: context.organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: context.userId,
        ...(approvedLocations === undefined ? {} : { approvedLocations }),
        ...(maxConcurrentAllocations === undefined
          ? {}
          : { maxConcurrentAllocations }),
        ...(maxSessionCostNanos === undefined ? {} : { maxSessionCostNanos }),
      }),
    );
  } catch (error) {
    return providerError(error, "failed to update provider guardrails");
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const context = await requestContext(request, params.orgId);
  if (!context.ok) return context.response;
  try {
    return jsonResponse(
      await disconnectProviderConnection({
        organizationId: context.organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: context.userId,
      }),
    );
  } catch (error) {
    return providerError(error, "failed to disconnect provider project");
  }
};

async function requestContext(request: Request, organizationKey?: string) {
  const authz = await requireUserContext(request);
  if (!authz.ok) return { ok: false as const, response: authz.response };
  const organizationId = await resolveOrganizationId(organizationKey ?? "");
  if (!organizationId) {
    return {
      ok: false as const,
      response: jsonResponse(
        { error: "organization not found", code: "organization_not_found" },
        { status: 404 },
      ),
    };
  }
  return { ok: true as const, organizationId, userId: authz.context.userId };
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

function providerError(error: unknown, fallback: string) {
  const { status, body } = toErrorResponse(error, fallback);
  return jsonResponse(body, { status });
}
