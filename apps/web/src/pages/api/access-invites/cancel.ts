import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { releaseAccessInviteLease } from "@/lib/access-invites";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { auth } from "@/lib/auth";
import {
  clearInviteAttemptCookie,
  readInviteAttempt,
} from "@/lib/invite-attempt";
import { requireSameOriginJsonMutation } from "@/lib/request-security";
import { copySetCookies } from "@/lib/response-cookies";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    requireSameOriginJsonMutation(request);
    // Cancellation must remain available even after an attempt cookie expires
    // or is corrupted so a restricted invite session can always sign out.
    const attempt = await readInviteAttempt(request).catch(() => null);
    if (attempt?.leaseId) {
      await releaseAccessInviteLease({
        d1: env.DB,
        inviteId: attempt.inviteId,
        leaseId: attempt.leaseId,
      });
    }

    const headers = new Headers();
    const signOutResponse = await auth.api
      .signOut({ headers: request.headers, asResponse: true })
      .catch(() => null);
    if (signOutResponse) copySetCookies(signOutResponse.headers, headers);
    headers.append("set-cookie", clearInviteAttemptCookie());
    return accessInviteJson({ canceled: true }, { headers });
  } catch (error) {
    return accessInviteError(error, "the invite attempt could not be canceled");
  }
};
