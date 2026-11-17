import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { renameOrganizationSlug } from "@/lib/organizations";

export const prerender = false;

/** The one slug rename, by an organization admin or a platform admin. */
export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = params.orgId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as { slug?: unknown } | null;
  try {
    const organization = await renameOrganizationSlug({
      organizationId,
      actorUserId: authz.context.userId,
      slug: typeof body?.slug === "string" ? body.slug : "",
    });
    return jsonResponse({ organization });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(error, "failed to change the organization slug");
    return jsonResponse(errorBody, { status });
  }
};
