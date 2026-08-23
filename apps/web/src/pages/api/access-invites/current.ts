import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { getBetaInviteStatus } from "@/lib/beta-invites";
import { readInviteAttempt } from "@/lib/invite-attempt";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const identity = await getAccessClaimIdentity(request);
    const user =
      identity?.githubUsername && identity.githubAccountId
        ? { id: identity.userId, githubUsername: identity.githubUsername }
        : undefined;
    if (identity?.accessState === "active") {
      return accessInviteJson({ state: "active", user });
    }

    const attempt = await readInviteAttempt(request);
    const invite = await getBetaInviteStatus({
      d1: env.DB,
      inviteId: attempt.inviteId,
    });
    if (!invite) return accessInviteJson({ state: "invalid" });
    if (invite.state !== "active") {
      return accessInviteJson({ state: invite.state });
    }
    if (identity && !identity.githubAccountId) {
      return accessInviteJson({ state: "github_required" });
    }
    if (identity && user) {
      return accessInviteJson({
        state: "authenticated",
        user,
        expiresAt: invite.expiresAt,
      });
    }
    return accessInviteJson({ state: "ready", expiresAt: invite.expiresAt });
  } catch (error) {
    return accessInviteError(error, "The beta invite could not be inspected");
  }
};
