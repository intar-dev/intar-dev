import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  createOrganization,
  listOrganizationsForUser,
} from "@/lib/organizations";
import {
  canCreateOrganization,
  hasReachedOwnedOrganizationLimit,
} from "@/lib/organization-access";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const [organizations, selected, limitReached] = await Promise.all([
      listOrganizationsForUser({ userId: authz.context.userId }),
      canCreateOrganization(authz.context.userId),
      hasReachedOwnedOrganizationLimit(authz.context.userId),
    ]);
    return jsonResponse({
      organizations,
      creation: {
        enabled: selected && !limitReached,
        reason: !selected
          ? "not_selected"
          : limitReached
            ? "owner_limit_reached"
            : null,
      },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list organizations",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;

  try {
    const organization = await createOrganization({
      name: typeof body?.name === "string" ? body.name : "",
      ownerUserId: authz.context.userId,
    });
    return jsonResponse({ organization }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to create organization",
    );
    return jsonResponse(errorBody, { status });
  }
};
