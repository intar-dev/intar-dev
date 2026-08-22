import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { revokeBetaUser } from "@/lib/access-invites";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError, AppError } from "@/lib/app-error";
import {
  cleanupBetaRevocation,
  getBetaRevocationStatus,
} from "@/lib/beta-access-revocation";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const userId = params.userId?.trim();
    if (!userId) throw appError(400, "user_id_required", "user id is required");
    const body = await readJsonObject(request);
    let revocation = await getBetaRevocationStatus(userId);
    if (!revocation) {
      try {
        const created = await revokeBetaUser({
          d1: env.DB,
          userId,
          actorUserId: authz.context.userId,
          reason: typeof body.reason === "string" ? body.reason : "",
        });
        revocation = {
          revocationId: created.revocationId,
          cleanup: "pending",
        };
      } catch (error) {
        // A concurrent administrator may have won the active -> blocked CAS.
        // Re-read that exact durable state instead of turning the loser into a
        // spurious non-idempotent failure.
        if (!(error instanceof AppError) || error.code !== "beta_user_not_active") {
          throw error;
        }
        revocation = await getBetaRevocationStatus(userId);
        if (!revocation) throw error;
      }
    }

    if (revocation.cleanup === "completed") {
      return accessInviteJson({
        userId,
        state: "blocked",
        revocationId: revocation.revocationId,
        cleanupCompleted: true,
      });
    }

    await cleanupBetaRevocation({
      userId,
      revocationId: revocation.revocationId,
      actorUserId: authz.context.userId,
    });
    return accessInviteJson({
      userId,
      state: "blocked",
      revocationId: revocation.revocationId,
      cleanupCompleted: true,
    });
  } catch (error) {
    return accessInviteError(error, "beta access could not be revoked");
  }
};
