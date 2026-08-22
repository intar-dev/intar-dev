import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  confirmAccessInvite,
  releaseAccessInviteLease,
} from "@/lib/access-invites";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { appError } from "@/lib/app-error";
import {
  clearInviteAttemptCookie,
  readInviteAttempt,
} from "@/lib/invite-attempt";
import { rateLimitPublicAccessInvite } from "@/lib/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    await rateLimitPublicAccessInvite({ request, action: "confirm" });
    const attempt = await readInviteAttempt(request);
    if (!attempt.leaseId || !attempt.leaseExpiresAt) {
      throw appError(
        409,
        "invite_lease_required",
        "continue with GitHub before claiming the invite",
      );
    }
    const identity = await getAccessClaimIdentity(request);
    if (!identity) {
      throw appError(401, "authentication_required", "GitHub sign-in is required");
    }

    if (identity.accessState === "active") {
      await releaseAccessInviteLease({
        d1: env.DB,
        inviteId: attempt.inviteId,
        leaseId: attempt.leaseId,
      });
      const headers = new Headers({
        "set-cookie": clearInviteAttemptCookie(),
      });
      return accessInviteJson({ state: "active", alreadyActive: true }, { headers });
    }
    if (identity.accessState === "blocked") {
      await releaseAccessInviteLease({
        d1: env.DB,
        inviteId: attempt.inviteId,
        leaseId: attempt.leaseId,
      });
      throw appError(
        403,
        "beta_user_blocked",
        "an administrator must clear this account's beta block",
      );
    }
    if (!identity.githubAccountId || !identity.githubUsername) {
      throw appError(
        409,
        "github_identity_required",
        "link the GitHub account used for this invite before claiming",
      );
    }

    const betaUser = await confirmAccessInvite({
      d1: env.DB,
      inviteId: attempt.inviteId,
      leaseId: attempt.leaseId,
      userId: identity.userId,
      githubAccountId: identity.githubAccountId,
      githubUsername: identity.githubUsername,
    });
    const headers = new Headers({
      "set-cookie": clearInviteAttemptCookie(),
    });
    return accessInviteJson({ state: "active", user: betaUser }, { headers });
  } catch (error) {
    return accessInviteError(error, "the invite could not be claimed");
  }
};
