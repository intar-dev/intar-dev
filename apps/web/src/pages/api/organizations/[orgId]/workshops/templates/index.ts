import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { requireWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { listWorkshopTemplates } from "@/lib/workshops/templates";

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
      templates: await listWorkshopTemplates({
        organizationId,
        userId: authz.context.userId,
      }),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list workshop templates",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async () =>
  jsonResponse(
    {
      error: "workshop templates must be published through the workshop registry",
      code: "workshop_registry_publish_required",
    },
    { status: 405, headers: { allow: "GET" } },
  );
