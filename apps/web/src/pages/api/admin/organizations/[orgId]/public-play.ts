import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { setPublicPlay } from "@/lib/organization-entitlements";

export const prerender = false;

const handler = (granted: boolean): APIRoute => async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    const entitlement = await setPublicPlay({
      organizationId: params.orgId?.trim() ?? "",
      actorUserId: authz.context.userId,
      granted,
    });
    return jsonResponse({ entitlement });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to change public play");
    return jsonResponse(body, { status });
  }
};

/** Grants the organization's play scenarios to everyone signed in. */
export const PUT = handler(true);
/** Keeps the organization's play scenarios to its members. */
export const DELETE = handler(false);
