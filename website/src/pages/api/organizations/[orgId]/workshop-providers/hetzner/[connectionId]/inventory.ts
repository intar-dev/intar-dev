import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { inspectHetznerProjectInventory } from "@/lib/workshops/provider-connections";

export const prerender = false;

const INVENTORY_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse(
      { error: "organization not found", code: "organization_not_found" },
      { status: 404, headers: INVENTORY_RESPONSE_HEADERS },
    );
  }
  try {
    return jsonResponse(
      await inspectHetznerProjectInventory({
        organizationId,
        connectionId: params.connectionId ?? "",
        actorUserId: authz.context.userId,
      }),
      { headers: INVENTORY_RESPONSE_HEADERS },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to inspect Hetzner project inventory",
    );
    return jsonResponse(body, {
      status,
      headers: INVENTORY_RESPONSE_HEADERS,
    });
  }
};
