import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
} from "@/lib/access-invite-http";
import { ensureAccessRevoked } from "@/lib/access-revocation";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import {
  assertPlatformUserDeletionAllowed,
  finalizePlatformUserDeletion,
} from "@/lib/platform-user-deletion-store";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const targetUserId = params.userId?.trim();
    if (!targetUserId) {
      throw appError(400, "user_id_required", "User id is required");
    }
    const actorUserId = authz.context.userId;
    await assertPlatformUserDeletionAllowed({
      d1: env.DB,
      targetUserId,
      actorUserId,
    });
    // Deletion revokes first, so sessions, runs and hosts are cleaned up
    // before the identity is anonymized.
    await ensureAccessRevoked({
      userId: targetUserId,
      actorUserId,
      reason: "admin_deleted",
    });
    await finalizePlatformUserDeletion({
      d1: env.DB,
      targetUserId,
      actorUserId,
    });
    return accessInviteJson({ deleted: true });
  } catch (error) {
    return accessInviteError(error, "The user could not be deleted");
  }
};
