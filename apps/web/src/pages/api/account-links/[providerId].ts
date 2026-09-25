import type { APIRoute } from "astro";
import { accessInviteError } from "@/lib/access-invite-http";
import { disconnectIdentity } from "@/lib/account-links";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";

export const prerender = false;

// Disconnects a sign-in method, GitHub or an organization's, from the
// signed-in account. Its other sessions and OAuth tokens end with it.
export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const providerId = params.providerId?.trim() ?? "";
  if (!providerId) {
    return jsonResponse({ error: "providerId is required" }, { status: 400 });
  }

  try {
    await disconnectIdentity({
      request,
      userId: authz.context.userId,
      providerId,
      currentSessionId: authz.context.sessionId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return accessInviteError(error, "failed to disconnect the sign-in method");
  }
};
