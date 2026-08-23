import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { appError } from "@/lib/app-error";
import { getBetaInvite } from "@/lib/beta-invites";
import {
  auth,
  createInviteOAuthHandoff,
  INVITE_OAUTH_HANDOFF_HEADER,
} from "@/lib/auth";
import {
  inviteAttemptSetCookie,
  readInviteAttempt,
} from "@/lib/invite-attempt";
import {
  canonicalApplicationOrigin,
  rateLimitPublicAccessInvite,
} from "@/lib/request-security";
import { copySetCookies } from "@/lib/response-cookies";

export const prerender = false;

const OAUTH_HANDOFF_TTL_MS = 10 * 60 * 1_000;

export const POST: APIRoute = async ({ request }) => {
  try {
    await rateLimitPublicAccessInvite({ request, action: "start" });
    const attempt = await readInviteAttempt(request);
    await getBetaInvite({ d1: env.DB, inviteId: attempt.inviteId });
    const identity = await getAccessClaimIdentity(request);
    if (identity?.accessState === "active") {
      throw appError(409, "already_active", "Beta access is already active");
    }
    if (identity && !identity.githubAccountId) {
      throw appError(
        409,
        "github_session_required",
        "Sign out, then claim this invite with GitHub",
      );
    }

    const authHeaders = new Headers(request.headers);
    const origin = canonicalApplicationOrigin();
    const handoff = await createInviteOAuthHandoff({
      inviteId: attempt.inviteId,
      attemptId: attempt.attemptId,
      expiresAt: Math.min(
        attempt.expiresAt,
        Date.now() + OAUTH_HANDOFF_TTL_MS,
      ),
    });
    authHeaders.set(INVITE_OAUTH_HANDOFF_HEADER, handoff);
    const authResponse = await auth.api.signInSocial({
      body: {
        provider: "github",
        callbackURL: `${origin}/join`,
        errorCallbackURL: `${origin}/join`,
        disableRedirect: true,
      },
      headers: authHeaders,
      asResponse: true,
    });
    if (!authResponse.ok) {
      throw new Error(`Better Auth returned ${authResponse.status}`);
    }
    const authBody = (await authResponse.json()) as { url?: unknown };
    if (typeof authBody.url !== "string" || !authBody.url) {
      throw new Error("Better Auth did not return a GitHub redirect");
    }

    const headers = new Headers();
    copySetCookies(authResponse.headers, headers);
    headers.append("set-cookie", await inviteAttemptSetCookie(attempt));
    return accessInviteJson(
      { redirectUrl: authBody.url, redirectKind: "github" },
      { headers },
    );
  } catch (error) {
    return accessInviteError(error, "GitHub sign-in could not be started");
  }
};
