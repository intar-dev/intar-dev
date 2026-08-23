import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError, AppError } from "@/lib/app-error";
import {
  cleanupBetaRevocation,
  getBetaRevocationStatus,
} from "@/lib/beta-access-revocation";
import { revokeBetaUser } from "@/lib/beta-access-revocation-store";
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

    let revocation = await getBetaRevocationStatus(targetUserId);
    if (!revocation) {
      try {
        const created = await revokeBetaUser({
          d1: env.DB,
          userId: targetUserId,
          actorUserId,
          reason: "admin_deleted",
        });
        revocation = { revocationId: created.revocationId, cleanup: "pending" };
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "beta_user_not_active") {
          throw error;
        }
        revocation = await getBetaRevocationStatus(targetUserId);
      }
    }
    if (revocation && revocation.cleanup !== "completed") {
      await cleanupBetaRevocation({
        userId: targetUserId,
        revocationId: revocation.revocationId,
        actorUserId,
      });
    }

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
