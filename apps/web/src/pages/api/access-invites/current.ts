import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { readInviteAttempt } from "@/lib/invite-attempt";

export const prerender = false;

interface InviteStatusRow {
  state: "pending" | "leased" | "redeemed" | "revoked";
  expires_at: number;
  lease_id: string | null;
  lease_expires_at: number | null;
}

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
    const invite = await env.DB.prepare(
      `SELECT state, expires_at, lease_id, lease_expires_at
       FROM access_invite_codes
       WHERE id = ?1
       LIMIT 1`,
    )
      .bind(attempt.inviteId)
      .first<InviteStatusRow>();
    if (identity?.accessState === "blocked") {
      return accessInviteJson({ state: "blocked", user });
    }
    if (!invite) return accessInviteJson({ state: "invalid" });
    if (invite.state === "redeemed") {
      return accessInviteJson({ state: "redeemed" });
    }
    if (invite.state === "revoked") {
      return accessInviteJson({ state: "revoked" });
    }

    const now = Date.now();
    if (invite.state === "pending" && invite.expires_at <= now) {
      return accessInviteJson({ state: "expired" });
    }
    if (invite.state === "leased") {
      const leaseStillActive = (invite.lease_expires_at ?? 0) > now;
      const ownsLease =
        leaseStillActive &&
        attempt.leaseId === invite.lease_id &&
        attempt.leaseExpiresAt === invite.lease_expires_at;
      if (ownsLease && identity && user) {
        return accessInviteJson({
          state: "authenticated",
          user,
          expiresAt: invite.expires_at,
          leaseExpiresAt: invite.lease_expires_at ?? undefined,
        });
      }
      if (leaseStillActive) {
        return accessInviteJson({
          state: "leased",
          leaseExpiresAt: invite.lease_expires_at ?? undefined,
          ownsLease,
        });
      }
    }

    return accessInviteJson({
      state: "ready",
      expiresAt: invite.expires_at,
    });
  } catch (error) {
    return accessInviteError(error, "the invite could not be inspected");
  }
};
