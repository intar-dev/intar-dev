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

const TOKEN_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;
const MAX_TOKEN_LIFETIME_MINUTES = 366 * 24 * 60;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse(
      { error: "organization not found" },
      { status: 404, headers: TOKEN_RESPONSE_HEADERS },
    );
  }
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    return jsonResponse(
      {
        tokens: await listWorkshopRegistryTokens({
          organizationId,
          actorUserId: authz.context.userId,
        }),
      },
      { headers: TOKEN_RESPONSE_HEADERS },
    );
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to list workshop registry tokens",
    );
    return jsonResponse(response.body, {
      status: response.status,
      headers: TOKEN_RESPONSE_HEADERS,
    });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse(
      { error: "organization not found" },
      { status: 404, headers: TOKEN_RESPONSE_HEADERS },
    );
  }
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("request body must be a JSON object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(
      {
        error: "request body must be a JSON object",
        code: "invalid_workshop_registry_token_request",
      },
      { status: 400, headers: TOKEN_RESPONSE_HEADERS },
    );
  }
  if (
    Object.keys(body).some(
      (key) => key !== "name" && key !== "expiresAfterMinutes",
    )
  ) {
    return invalidTokenRequest("request contains unsupported fields");
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return invalidTokenRequest("token name must be a string");
  }
  if (
    body.expiresAfterMinutes !== undefined &&
    (typeof body.expiresAfterMinutes !== "number" ||
      !Number.isSafeInteger(body.expiresAfterMinutes) ||
      body.expiresAfterMinutes < 1 ||
      body.expiresAfterMinutes > MAX_TOKEN_LIFETIME_MINUTES)
  ) {
    return invalidTokenRequest(
      "token lifetime must be a whole number from 1 minute through 366 days",
    );
  }
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    const expiresAt =
      typeof body.expiresAfterMinutes === "number"
        ? Date.now() + body.expiresAfterMinutes * 60_000
        : undefined;
    const token = await createWorkshopRegistryToken({
      organizationId,
      actorUserId: authz.context.userId,
      name:
        typeof body.name === "string" ? body.name : "Workshop publisher",
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return jsonResponse(token, {
      status: 201,
      headers: TOKEN_RESPONSE_HEADERS,
    });
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to create workshop registry token",
    );
    return jsonResponse(response.body, {
      status: response.status,
      headers: TOKEN_RESPONSE_HEADERS,
    });
  }
};

function invalidTokenRequest(error: string): Response {
  return jsonResponse(
    {
      error,
      code: "invalid_workshop_registry_token_request",
    },
    { status: 400, headers: TOKEN_RESPONSE_HEADERS },
  );
}
