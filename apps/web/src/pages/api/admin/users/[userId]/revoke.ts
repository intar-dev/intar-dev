import type { APIRoute } from "astro";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
} from "@/lib/access-invite-http";
import { ensureAccessRevoked } from "@/lib/access-revocation";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";

export const prerender = false;

// Revoking is terminal. Repeating the request finishes a cleanup that did not
// complete and leaves a finished revocation as it is. The body is ignored.
export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const userId = params.userId?.trim();
    if (!userId) throw appError(400, "user_id_required", "User id is required");
    const { revocationId } = await ensureAccessRevoked({
      userId,
      actorUserId: authz.context.userId,
      reason: "admin_revoked",
    });
    return accessInviteJson({
      userId,
      access: "revoked",
      revocationId,
      cleanupCompleted: true,
    });
  } catch (error) {
    return accessInviteError(error, "Access could not be revoked");
  }
};
