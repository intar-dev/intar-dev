import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  leaseAccessInvite,
  releaseAccessInviteLease,
  validateGithubInviteLease,
  type AccessInviteLease,
} from "@/lib/access-invites";
import {
  accessInviteError,
  accessInviteJson,
  readJsonObject,
} from "@/lib/access-invite-http";
import { getAccessClaimIdentity } from "@/lib/access-claim";
import { appError } from "@/lib/app-error";
import { resolveBetaOidcProvider } from "@/lib/access-sso";
import {
  auth,
  createGithubRecoveryOAuthHandoff,
  createInviteOAuthHandoff,
  createSsoRecoveryOAuthHandoff,
  INVITE_OAUTH_HANDOFF_HEADER,
} from "@/lib/auth";
import {
  inviteAttemptSetCookie,
  readInviteAttempt,
  withInviteLease,
  type InviteAttempt,
} from "@/lib/invite-attempt";
import {
  canonicalApplicationOrigin,
  rateLimitPublicAccessInvite,
  requireSameOriginJsonMutation,
} from "@/lib/request-security";
import { copySetCookies } from "@/lib/response-cookies";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let leased: { inviteId: string; leaseId: string } | null = null;
  try {
    requireSameOriginJsonMutation(request);
    await rateLimitPublicAccessInvite({ request, action: "start" });
    const body = await readJsonObject(request);
    const mode = body.mode === "sso-recovery" ? body.mode : "github";
    const attempt = await readInviteAttempt(request);
    const lease = await leaseForAttempt(attempt);
    leased = lease;

    const authHeaders = new Headers(request.headers);
    const origin = canonicalApplicationOrigin();
    let authResponse: Response;
    let redirectKind: "github" | "sso";

    if (mode === "sso-recovery") {
      if (typeof body.organizationSlug !== "string") {
        throw appError(
          400,
          "organization_slug_required",
          "organization slug is required",
        );
      }
      const provider = await resolveBetaOidcProvider(body.organizationSlug);
      const handoff = await createSsoRecoveryOAuthHandoff({
        inviteId: lease.inviteId,
        leaseId: lease.leaseId,
        leaseExpiresAt: lease.leaseExpiresAt,
        providerId: provider.providerId,
      });
      authHeaders.set(INVITE_OAUTH_HANDOFF_HEADER, handoff);
      authResponse = await auth.api.signInSSO({
        body: {
          providerId: provider.providerId,
          providerType: "oidc",
          callbackURL: `${origin}/join`,
          errorCallbackURL: `${origin}/join`,
          newUserCallbackURL: `${origin}/join`,
          requestSignUp: false,
          scopes: ["openid", "email", "profile", "offline_access"],
        },
        headers: authHeaders,
        asResponse: true,
      });
      redirectKind = "sso";
    } else {
      const identity = await getAccessClaimIdentity(request);
      if (identity && !identity.githubAccountId) {
        const handoff = await createGithubRecoveryOAuthHandoff({
          inviteId: lease.inviteId,
          leaseId: lease.leaseId,
          leaseExpiresAt: lease.leaseExpiresAt,
          userId: identity.userId,
        });
        authHeaders.set(INVITE_OAUTH_HANDOFF_HEADER, handoff);
        authResponse = await auth.api.linkSocialAccount({
          body: {
            provider: "github",
            callbackURL: `${origin}/join`,
            errorCallbackURL: `${origin}/join`,
            disableRedirect: true,
            requestSignUp: false,
          },
          headers: authHeaders,
          asResponse: true,
        });
      } else {
        const handoff = await createInviteOAuthHandoff({
          inviteId: lease.inviteId,
          leaseId: lease.leaseId,
          leaseExpiresAt: lease.leaseExpiresAt,
        });
        authHeaders.set(INVITE_OAUTH_HANDOFF_HEADER, handoff);
        authResponse = await auth.api.signInSocial({
          body: {
            provider: "github",
            callbackURL: `${origin}/join`,
            errorCallbackURL: `${origin}/join`,
            disableRedirect: true,
          },
          headers: authHeaders,
          asResponse: true,
        });
      }
      redirectKind = "github";
    }
    if (!authResponse.ok) {
      throw new Error(`Better Auth returned ${authResponse.status}`);
    }
    const authBody = (await authResponse.json()) as {
      url?: unknown;
      redirect?: unknown;
    };
    if (typeof authBody.url !== "string" || !authBody.url) {
      throw new Error("Better Auth did not return a GitHub redirect");
    }

    const headers = new Headers();
    copySetCookies(authResponse.headers, headers);
    headers.append(
      "set-cookie",
      await inviteAttemptSetCookie(withInviteLease(attempt, lease)),
    );
    return accessInviteJson(
      {
        redirectUrl: authBody.url,
        redirectKind,
        leaseExpiresAt: lease.leaseExpiresAt,
      },
      { headers },
    );
  } catch (error) {
    if (leased) {
      await releaseAccessInviteLease({
        d1: env.DB,
        inviteId: leased.inviteId,
        leaseId: leased.leaseId,
      }).catch(() => false);
    }
    return accessInviteError(error, "GitHub sign-in could not be started");
  }
};

async function leaseForAttempt(
  attempt: InviteAttempt,
): Promise<AccessInviteLease> {
  if (attempt.leaseId) {
    try {
      return await validateGithubInviteLease({
        d1: env.DB,
        inviteId: attempt.inviteId,
        leaseId: attempt.leaseId,
        providerId: "github",
      });
    } catch {
      // An expired lease can be reacquired below. A live lease owned by
      // another attempt will still fail the atomic UPDATE in D1.
    }
  }
  return leaseAccessInvite({ d1: env.DB, inviteId: attempt.inviteId });
}
