import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { inspectBetaInviteCode } from "@/lib/beta-invites";
import {
  accessInviteError,
  accessInviteJson,
  readJsonObject,
} from "@/lib/access-invite-http";
import {
  inviteAttemptSetCookie,
  newInviteAttempt,
  readInviteAttempt,
} from "@/lib/invite-attempt";
import { rateLimitPublicAccessInvite } from "@/lib/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    await rateLimitPublicAccessInvite({ request, action: "exchange" });
    const body = await readJsonObject(request);
    const code = typeof body.code === "string" ? body.code : "";
    const invite = await inspectBetaInviteCode({ d1: env.DB, code });
    const existingAttempt = await readInviteAttempt(request).catch(() => null);
    const attempt =
      existingAttempt?.inviteId === invite.inviteId
        ? existingAttempt
        : newInviteAttempt(invite.inviteId);
    const headers = new Headers();
    headers.append("set-cookie", await inviteAttemptSetCookie(attempt));
    return accessInviteJson(
      { state: "ready", expiresAt: invite.expiresAt },
      { status: 200, headers },
    );
  } catch (error) {
    return accessInviteError(error, "the invite could not be exchanged");
  }
};
