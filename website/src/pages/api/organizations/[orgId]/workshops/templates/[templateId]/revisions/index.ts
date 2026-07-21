import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { requireWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { listWorkshopTemplateRevisions } from "@/lib/workshops/templates";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const context = await routeContext(request, params);
  if (context instanceof Response) return context;
  try {
    await requireWorkshopsEnabledForOrganization(context.organizationId);
    return jsonResponse({
      revisions: await listWorkshopTemplateRevisions({
        organizationId: context.organizationId,
        templateId: context.templateId,
        userId: context.userId,
      }),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list workshop revisions",
    );
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async () =>
  jsonResponse(
    {
      error: "workshop revisions must be published through the workshop registry",
      code: "workshop_registry_publish_required",
    },
    { status: 405, headers: { allow: "GET" } },
  );

async function routeContext(
  request: Request,
  params: Record<string, string | undefined>,
): Promise<
  | Response
  | { organizationId: string; templateId: string; userId: string }
> {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  const templateId = params.templateId?.trim() ?? "";
  if (!organizationId || !templateId) {
    return jsonResponse(
      { error: "organization or template not found" },
      { status: 404 },
    );
  }
  return { organizationId, templateId, userId: authz.context.userId };
}
