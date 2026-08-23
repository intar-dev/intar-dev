import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { appError } from "@/lib/app-error";
import { redeemBetaInvite } from "@/lib/beta-invites";
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
    const identity = await getAccessClaimIdentity(request);
    if (!identity) {
      throw appError(401, "authentication_required", "GitHub sign-in is required");
    }
    if (identity.accessState === "active") {
      return accessInviteJson(
        { state: "active" },
        { headers: { "set-cookie": clearInviteAttemptCookie() } },
      );
    }
    if (!identity.githubAccountId || !identity.githubUsername) {
      throw appError(
        409,
        "github_identity_required",
        "This invite must be claimed with GitHub",
      );
    }

    const betaUser = await redeemBetaInvite({
      d1: env.DB,
      inviteId: attempt.inviteId,
      attemptId: attempt.attemptId,
      userId: identity.userId,
      githubAccountId: identity.githubAccountId,
      githubUsername: identity.githubUsername,
    });
    return accessInviteJson(
      { state: "active", user: betaUser },
      { headers: { "set-cookie": clearInviteAttemptCookie() } },
    );
  } catch (error) {
    return accessInviteError(error, "The beta invite could not be claimed");
  }
};
