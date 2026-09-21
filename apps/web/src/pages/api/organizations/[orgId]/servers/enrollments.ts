import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore, readJsonObject } from "@/lib/access-invite-http";
import { appError } from "@/lib/app-error";
import { createHostEnrollment } from "@/lib/host-enrollment";
import { requireOrganizationServerAccess } from "@/lib/organization-servers";

export const prerender = false;
export const POST: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const organizationId = await requireOrganizationServerAccess(auth.context, params.orgId ?? "", true);
    const input = await readJsonObject(request);
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80
      || Object.keys(input).some(key => key !== "name")) {
      throw appError(400, "invalid_server_enrollment", "Enter a server name of 1 to 80 characters.");
    }
    const gate = await env.DB.prepare("SELECT state FROM runtime_operation_gates WHERE key = 'personal_metal_registration'").first<{ state: string }>();
    if (gate?.state !== "open") throw appError(503, "server_registration_closed", "Server registration is not available yet.");
    return accessInviteJson(await createHostEnrollment(env.DB, auth.context, {
      name: input.name.trim(), scope: "organization", role: "agent", organizationId,
    }), { status: 201 });
  } catch (error) { return accessInviteError(error, "Could not register the organization server. Try again."); }
};
