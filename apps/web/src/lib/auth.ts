import { recordSecurityEvent } from "@/lib/security-events";
import { env } from "cloudflare:workers";
import type { GenericEndpointContext } from "@better-auth/core";
import { defineRequestState } from "@better-auth/core/context";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import type { Session, User } from "better-auth";
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
} from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, organization, username } from "better-auth/plugins";
import { isRecord } from "@/control-plane/image-registry/shared";
import * as schema from "../db/schema";
import { db } from "../db/client";
import {
  canSignIn,
  identityState,
  isActiveAccount,
  isImpersonatedSession,
  RECENT_SIGN_IN_SECONDS,
  sessionMayAct,
  usableIdentityExistsSql,
} from "./account-access";
import { authSetting } from "./auth-runtime";
import { getUserRole, isAdminRole } from "./authz";
import { encodeBase64Url } from "./base64url";
import {
  isValidGithubUsername,
  normalizeGithubUsername,
} from "./github-username";
import { createAppId } from "./id";
import { createOidcSsoAdapterFactory } from "./oidc-sso-adapter";
import {
  canCreateOrganization,
  hasReachedOwnedOrganizationLimit,
} from "./organization-access";
import {
  checkLinkSession,
  checkSsoReclaim,
  checkSsoSignUp,
  completeSsoLink,
  deleteUnclaimedSsoUser,
  organizationSignUpFields,
  provisionOrganizationMember,
  removedLoginRedirect,
  SSO_INTENT_CONTEXT_KEY,
  SSO_INTENT_HEADER,
  ssoIntentFromState,
  ssoSignInState,
  verifySsoIntent,
} from "./organization-sso";
import {
  linkErrorURL,
  SSO_ERROR_MESSAGES,
  ssoRejection,
  withErrorCode,
} from "./organization-sso-errors";
import {
  clearSignupReservation,
  hasOpenSignupSpot,
  reserveSignupSpot,
} from "./signups";
import { SIGNUPS_FULL_MESSAGE } from "./signup-status";

const baseURL = authSetting("BETTER_AUTH_URL") ?? "http://localhost:4321";

const oauthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "roles",
] as const;

const oauthAdvertisedClaims = [
  "sub",
  "iss",
  "aud",
  "exp",
  "iat",
  "sid",
  "scope",
  "azp",
  "email",
  "email_verified",
  "name",
  "picture",
  "family_name",
  "given_name",
  "role",
  "roles",
] as const;

// The user an OAuth token response is issued for, and whether the provider
// ran a refresh grant. The after hook rechecks both once the provider has
// stored the tokens.
const oauthIssuanceState = defineRequestState<{
  userId: string;
  refreshGrant: boolean;
} | null>(() => null);

const rejectIdentity = (
  error: string,
  description = "This identity cannot be used to sign in",
) => ({ error, errorDescription: description });

function throwAccessError(
  code: string,
  message = "This account no longer has access",
): never {
  throw new APIError("FORBIDDEN", { code, message });
}

const getOAuthRoleClaims = async (user: User, scopes: readonly string[]) => {
  if (!(await isActiveAccount(user.id))) {
    throwAccessError("access_revoked");
  }

  if (!scopes.includes("roles")) {
    return {};
  }

  const role =
    getUserRole(user as { role?: string | null | undefined }) ?? "user";

  return {
    role,
    roles: [role],
  };
};

export async function getOAuthAccessTokenClaims(input: {
  resources?: readonly string[] | undefined;
  scopes: readonly string[];
  user: User;
}): Promise<Record<string, unknown>> {
  // oauth-provider makes access tokens self-contained JWTs whenever an RFC
  // 8707 resource/audience is requested. Those tokens cannot be revoked
  // immediately when an account loses access, so OAuth supports only the
  // provider's ordinary opaque access-token mode.
  if (input.resources?.length) {
    throw new APIError("BAD_REQUEST", {
      code: "oauth_resource_tokens_disabled",
      error: "invalid_target",
      error_description: "resource audience tokens are unavailable",
      message: "Resource audience tokens are unavailable",
    });
  }
  return getOAuthRoleClaims(input.user, input.scopes);
}

function emailLocalPart(email: unknown): string {
  const local = typeof email === "string" ? email.split("@", 1)[0]?.trim() : "";
  return local || "Member";
}

/**
 * Runs after the provider stored an OAuth token response. An account that can
 * still sign in keeps them. Otherwise a revocation or sign-out committed
 * during issuance without seeing them, so the issued tokens are removed and
 * the response is suppressed. A refresh grant also needs the token it
 * rotated: rotation keeps its row, so a missing one means a sign-out deleted
 * it while the new tokens were being issued.
 */
export async function enforceActiveOAuthIssuance(input: {
  userId: string;
  returned: unknown;
  /** The refresh token a refresh grant presented. */
  presentedRefreshToken?: string | null | undefined;
}): Promise<void> {
  const [allowed, rotatedTokenKept] = await Promise.all([
    canSignIn(input.userId),
    input.presentedRefreshToken
      ? storedRefreshTokenExists(input.userId, input.presentedRefreshToken)
      : true,
  ]);
  if (allowed && rotatedTokenKept) return;

  const returned = isRecord(input.returned) ? input.returned : {};
  const accessToken =
    typeof returned.access_token === "string" ? returned.access_token : null;
  const refreshToken =
    typeof returned.refresh_token === "string" ? returned.refresh_token : null;
  try {
    await deleteExactIssuedOAuthTokens({
      userId: input.userId,
      accessToken,
      refreshToken,
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      "account access was revoked during OAuth issuance and issued tokens could not be removed",
    );
  }
  throwAccessError(
    "access_revoked",
    "Account access was revoked while the OAuth credential was being issued",
  );
}

async function deleteExactIssuedOAuthTokens(input: {
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
}): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (input.accessToken) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM oauth_access_token WHERE token = ? AND user_id = ?",
      ).bind(await hashStoredOAuthToken(input.accessToken), input.userId),
    );
  }
  if (input.refreshToken) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM oauth_refresh_token WHERE token = ? AND user_id = ?",
      ).bind(await hashStoredOAuthToken(input.refreshToken), input.userId),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

async function storedRefreshTokenExists(
  userId: string,
  refreshToken: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS stored FROM oauth_refresh_token WHERE token = ? AND user_id = ?",
  )
    .bind(await hashStoredOAuthToken(refreshToken), userId)
    .first<{ stored: number }>();
  return row !== null;
}

async function hashStoredOAuthToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function deleteExactSession(session: Session): Promise<void> {
  await env.DB.prepare("DELETE FROM session WHERE token = ? AND user_id = ?")
    .bind(session.token, session.userId)
    .run();
}

// What one callback's checks decided, for the database hooks that follow.
// Better Auth hands validateUserInfo and every database hook of a request the
// same endpoint context, while request state is gone by the time after hooks
// run.
interface CallbackNote {
  /** The provider the callback signs in through; its session needs it. */
  signInProvider?: string | undefined;
  /** The existing account an identity is connected to, which is audited. */
  linkedUserId?: string | undefined;
  /** The connected GitHub account's login, for an account without a username. */
  githubLogin?: string | undefined;
  /** The user an organization sign-up created in this callback. */
  createdUserId?: string | undefined;
  /** The sign-up spot the account insert reserved, cleared after it. */
  reservedFor?: string | undefined;
  /** The session an explicit GitHub link started from, rechecked after it. */
  linkSessionId?: string | undefined;
}
const callbackNotes = new WeakMap<object, CallbackNote>();

function noteCallback(context: unknown, note: CallbackNote): void {
  if (!isRecord(context)) return;
  callbackNotes.set(context, { ...callbackNotes.get(context), ...note });
}

function callbackNote(context: unknown): CallbackNote {
  return (isRecord(context) ? callbackNotes.get(context) : undefined) ?? {};
}

function githubLoginOf(profile: unknown): string | undefined {
  const login =
    isRecord(profile) && typeof profile.login === "string"
      ? profile.login.trim()
      : "";
  return login && isValidGithubUsername(login) ? login : undefined;
}

/**
 * An account holds a session only while it is active and some identity can
 * still sign it in (see sessionMayAct). A callback's session needs the
 * identity it signed in with, which a disconnect or removal in the meantime
 * may have taken away.
 */
async function sessionAccountAllowed(
  session: Session,
  context: unknown,
): Promise<boolean> {
  return sessionMayAct(session, callbackNote(context).signInProvider ?? null);
}

/**
 * Runs after a session row exists. A revocation, removal, or disconnect that
 * committed between the create hook's check and the insert has already signed
 * the account out, so the late row is removed here.
 */
export async function enforceCreatedSessionStillActive(
  session: Session,
  context?: unknown,
): Promise<void> {
  if (await sessionAccountAllowed(session, context)) return;
  await deleteExactSession(session);
  throwAccessError(
    "access_revoked",
    "Account access changed while the session was being created",
  );
}

/**
 * A person's first identity takes a sign-up spot; connecting another one
 * never does. One guarded insert, so concurrent sign-ups for the last spot
 * admit exactly one.
 */
async function reserveFirstIdentitySpot(
  context: GenericEndpointContext,
  state: unknown,
  userId: string,
  linked: boolean,
): Promise<void> {
  if (linked) return;
  if (!(await reserveSignupSpot({ userId }))) {
    refuseAccountInsert(context, state, "signups_full", SIGNUPS_FULL_MESSAGE);
  }
  noteCallback(context, { reservedFor: userId });
}

/**
 * Gives an account that has no username, such as one an organization sign-up
 * created, the login of the GitHub account it just connected. A login another
 * account already uses is left alone.
 */
async function adoptGithubUsername(userId: string, login: string): Promise<void> {
  const username = normalizeGithubUsername(login);
  if (!username) return;
  try {
    await env.DB.prepare(
      `UPDATE user SET username = ?2, display_username = ?3, updated_at = ?4
       WHERE id = ?1 AND username IS NULL
         AND NOT EXISTS (SELECT 1 FROM user AS taken WHERE taken.username = ?2)`,
    )
      .bind(userId, username, login, Date.now())
      .run();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "github_username_adopt_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Refuses an account insert. Better Auth's explicit link callback runs the
 * insert without its error-to-redirect handling, so a thrown refusal would end
 * on a JSON page: that flow returns to its error URL with the code instead.
 */
function refuseAccountInsert(
  context: GenericEndpointContext,
  state: unknown,
  code: string,
  message: string,
): never {
  if (isRecord(state) && isRecord(state.link)) {
    throw context.redirect(
      withErrorCode(linkErrorURL(state) ?? "/", code, baseURL),
    );
  }
  throw new APIError("FORBIDDEN", { code, message });
}

async function readOAuthState(): Promise<
  Awaited<ReturnType<typeof getOAuthState>>
> {
  try {
    return await getOAuthState();
  } catch {
    // Non-OAuth provisioning has no OAuth request state. Treating that as an
    // absent trusted flow keeps the identity gate fail-closed.
    return null;
  }
}

// Routes that only end a session or finish a sign-in.
const SESSION_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/sign-out",
  "/oauth2/end-session",
  "/admin/stop-impersonating",
  "/callback/:id",
  "/sso/callback",
  "/sso/callback/:providerId",
]);

// Routes that grant or widen an app's access to the account.
const IMPERSONATION_OAUTH_PATHS: ReadonlySet<string> = new Set([
  "/oauth2/authorize",
  "/oauth2/consent",
  "/oauth2/update-consent",
]);

const accountAccessBeforeRequest = createAuthMiddleware(async (context) => {
  // disabledPaths protects HTTP. This guard also protects direct auth.api
  // calls, including leaveOrganization, which has no member-removal hook.
  if (context.path === "/organization/leave" || context.path === "/organization/remove-member") {
    throw new APIError("FORBIDDEN", { message: "Use the application organization membership routes" });
  }
  // Usernames come from GitHub. The username plugin only freezes one once it
  // is set, so an account without one could otherwise claim any login.
  if (context.path === "/update-user") {
    throw new APIError("FORBIDDEN", { message: "Profile details come from your sign-in provider" });
  }
  // Better Auth's id-token shortcut signs in or links without the state-bound
  // redirect, and its link path skips validateUserInfo in 1.7.0-beta.10.
  if (
    (context.path === "/sign-in/social" || context.path === "/link-social") &&
    isRecord(context.body) &&
    context.body.idToken !== undefined
  ) {
    throwAccessError(
      "id_token_sign_in_disabled",
      "Continue through the provider's sign-in page",
    );
  }
  // A signed-in account can connect GitHub through Better Auth's link flow.
  // Organizations connect through the organization sign-in link intent.
  if (
    context.path === "/link-social" &&
    (!isRecord(context.body) || context.body.provider !== "github")
  ) {
    throwAccessError(
      "link_provider_unsupported",
      "Only GitHub can be connected here",
    );
  }
  // Session inspection carries no credential material beyond the cookie, and
  // every protected call re-reads the account through requireUserContext.
  if (context.path === "/get-session") return undefined;

  const requestHeaders = context.request?.headers ?? context.headers;
  const encodedIntent = requestHeaders?.get(SSO_INTENT_HEADER);
  if (encodedIntent && context.path !== "/sign-in/sso") {
    throwAccessError(
      "sso_intent_mismatch",
      "The organization sign-in request does not match its intent",
    );
  }
  // Any session may sign out, end an impersonation, or finish a sign-in
  // callback, even one whose account lost access: the identity gate checks
  // the callback's own account. Hooks see route templates, not request paths.
  if (SESSION_EXEMPT_PATHS.has(context.path)) return undefined;

  const session = await getSessionFromCtx(context, {
    disableCookieCache: true,
    disableRefresh: true,
  });
  const sessionUserId = session?.user.id ?? null;
  // A session lasts only while its account can sign in, as when it was made.
  const sessionActive = session ? await sessionMayAct(session.session) : false;
  // An admin impersonating someone must not leave a sign-in method or app
  // grant of their own on that account: it would outlive the impersonation.
  const impersonating = isImpersonatedSession(session?.session);
  if (context.path === "/link-social" && impersonating) {
    throwAccessError(
      "impersonation_link_forbidden",
      SSO_ERROR_MESSAGES.impersonation_link_forbidden,
    );
  }
  if (impersonating && IMPERSONATION_OAUTH_PATHS.has(context.path)) {
    throwAccessError(
      "impersonation_oauth_forbidden",
      "Stop impersonating before authorizing apps",
    );
  }
  // A connected sign-in method stays a way in, so connecting one needs a
  // recent sign-in, like Better Auth's fresh-session routes: an older session
  // someone took over can't add their own.
  const recentSignIn =
    !session ||
    Date.now() - new Date(session.session.createdAt).getTime() <
      RECENT_SIGN_IN_SECONDS * 1000;
  if (context.path === "/link-social" && !recentSignIn) {
    throwAccessError("session_not_fresh", "Sign in again to connect GitHub");
  }

  if (context.path === "/sign-in/sso") {
    // Organization sign-in starts only from Intar's routes. Their signed
    // intent travels in the OAuth state, and the callback enforces it.
    const intent = encodedIntent ? await verifySsoIntent(encodedIntent) : null;
    if (!intent) {
      throwAccessError(
        "sso_intent_required",
        "Start organization sign-in from Intar",
      );
    }
    if (intent.kind === "link" && impersonating) {
      throwAccessError(
        "impersonation_link_forbidden",
        SSO_ERROR_MESSAGES.impersonation_link_forbidden,
      );
    }
    if (intent.kind === "link" && !recentSignIn) {
      throwAccessError(
        "session_not_fresh",
        "Sign in again to connect your organization",
      );
    }
    if (
      !isRecord(context.body) ||
      context.body.providerId !== intent.providerId ||
      // Intents are signed only for OIDC providers; SAML RelayState would
      // drop the intent the callback needs.
      context.body.providerType === "saml" ||
      (intent.kind === "link" &&
        (sessionUserId !== intent.userId || !sessionActive))
    ) {
      throwAccessError(
        "sso_intent_mismatch",
        "The organization sign-in request does not match its intent",
      );
    }
    await addOAuthServerContext({ [SSO_INTENT_CONTEXT_KEY]: intent });
  }

  if (!sessionUserId || sessionActive) return undefined;
  return throwAccessError("access_revoked");
});

const accountAccessAfterRequest = createAuthMiddleware(async (context) => {
  if (context.path === "/oauth2/token") {
    const issuance = await oauthIssuanceState.get();
    if (issuance) {
      // The grant type comes from the provider, which normalizes it; the
      // refresh token is the raw value it looked up.
      const presented =
        issuance.refreshGrant && isRecord(context.body)
          ? context.body.refresh_token
          : null;
      await enforceActiveOAuthIssuance({
        userId: issuance.userId,
        returned: context.context.returned,
        presentedRefreshToken: typeof presented === "string" ? presented : null,
      });
    }
    return undefined;
  }

  if (
    context.path !== "/oauth2/introspect" &&
    context.path !== "/oauth2/userinfo"
  ) {
    return undefined;
  }

  // The provider has authenticated the introspection client / bearer token by
  // this point. Public subject identifiers are Better Auth user ids because
  // this provider does not enable pairwise subjects. A token lasts only while
  // its account can sign in, like a session.
  const returned = context.context.returned;
  const subject = isRecord(returned) ? returned.sub : null;
  if (typeof subject !== "string" || (await canSignIn(subject))) {
    return undefined;
  }

  if (context.path === "/oauth2/introspect") {
    return context.json({ active: false });
  }
  throw new APIError("UNAUTHORIZED", {
    code: "access_revoked",
    message: "OAuth credential is no longer active",
  });
});

async function emailVerifiedFor(userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT email_verified AS verified FROM user WHERE id = ?1",
  )
    .bind(userId)
    .first<{ verified: number }>();
  return row?.verified === 1;
}

async function validateProviderIdentity(
  data: {
    user: Partial<User> & Record<string, unknown>;
    source: {
      action: "create-user" | "link-account" | "sign-in";
      method: string;
      oauth?:
        | { providerId: string; profile?: Record<string, unknown> | undefined }
        | undefined;
      sso?:
        | { providerId: string; profile?: Record<string, unknown> | undefined }
        | undefined;
    };
  },
  context: unknown,
) {
  const state = await readOAuthState();
  const ssoIntent = ssoIntentFromState(state);
  // Better Auth's explicit link flow (linkSocial) stores the signed-in user in
  // the state; its callback passes the provider's account id as `user.id`.
  const explicitLinkUserId =
    typeof state?.link?.userId === "string" ? state.link.userId : null;
  const incomingUserId =
    typeof data.user.id === "string" ? data.user.id : null;
  const targetUserId =
    data.source.action === "create-user"
      ? null
      : (explicitLinkUserId ?? incomingUserId);

  if (data.source.method === "oauth") {
    if (data.source.oauth?.providerId !== "github") {
      return rejectIdentity(
        "unsupported_oauth_provider",
        "Sign in with GitHub",
      );
    }
    // A GitHub callback never finishes an organization sign-in.
    if (ssoIntent) {
      return rejectIdentity("github_flow_invalid", "Start GitHub sign-in again");
    }

    switch (data.source.action) {
      case "sign-in":
        if (!(await isActiveAccount(targetUserId))) {
          return rejectIdentity("access_revoked", "This account no longer has access");
        }
        noteCallback(context, { signInProvider: "github" });
        return undefined;
      case "create-user":
        // A cheap pre-check that keeps a full cap from creating account-less
        // user rows. The account hook's reservation is authoritative.
        if (!(await hasOpenSignupSpot({ userId: null }))) {
          return rejectIdentity("signups_full", SIGNUPS_FULL_MESSAGE);
        }
        noteCallback(context, { signInProvider: "github" });
        return undefined;
      case "link-account": {
        // Connect GitHub from Profile: the signed-in account that started the
        // link receives the GitHub identity, whatever its email.
        if (explicitLinkUserId) {
          const [link, identity] = await Promise.all([
            checkLinkSession(
              context as GenericEndpointContext,
              explicitLinkUserId,
            ),
            identityState(explicitLinkUserId),
          ]);
          if (link.refusal) {
            return rejectIdentity(
              link.refusal,
              link.refusal === "access_revoked"
                ? "This account no longer has access"
                : SSO_ERROR_MESSAGES[link.refusal],
            );
          }
          if (identity.github) {
            return rejectIdentity(
              "github_already_connected",
              "This account already has a GitHub account",
            );
          }
          noteCallback(context, {
            linkedUserId: explicitLinkUserId,
            githubLogin: githubLoginOf(data.source.oauth?.profile),
            linkSessionId: link.sessionId,
          });
          return undefined;
        }
        const [active, identity] = targetUserId
          ? await Promise.all([
              isActiveAccount(targetUserId),
              identityState(targetUserId),
            ])
          : [false, null];
        if (!targetUserId || !active || !identity) {
          return rejectIdentity(
            "access_revoked",
            "This account no longer has access",
          );
        }
        // Better Auth classifies a GitHub callback as `link-account` when its
        // verified email matches an existing user without this GitHub
        // identity. Only an account nobody can sign in to may be taken over
        // this way: a sign-up that stopped between its inserts, or an account
        // whose organization identity is gone or removed.
        if (!identity.reclaimable) {
          return identity.github
            ? rejectIdentity(
                "github_account_mismatch",
                "This email's Intar account signs in with a different GitHub account",
              )
            : rejectIdentity(
                "explicit_github_link_required",
                "An Intar account already uses this email. Sign in to it, then connect GitHub from your profile.",
              );
        }
        // Only an address Intar verified: an approved organization provider's
        // other addresses never let a GitHub sign-in take the account over.
        if (!(await emailVerifiedFor(targetUserId))) {
          return rejectIdentity(
            "explicit_github_link_required",
            "An Intar account already uses this email. Sign in to it, then connect GitHub from your profile.",
          );
        }
        // An account that still has identity rows already holds a spot.
        if (!identity.linked && !(await hasOpenSignupSpot({ userId: targetUserId }))) {
          return rejectIdentity("signups_full", SIGNUPS_FULL_MESSAGE);
        }
        noteCallback(context, {
          signInProvider: "github",
          linkedUserId: targetUserId,
          githubLogin: githubLoginOf(data.source.oauth?.profile),
        });
        return undefined;
      }
    }
  }

  if (
    data.source.method === "sso-oidc" ||
    data.source.method === "sso-saml"
  ) {
    const providerId = data.source.sso?.providerId;
    if (!providerId) {
      return rejectIdentity(
        "sso_provider_missing",
        "The organization identity provider is missing",
      );
    }
    // Explicit links finish in the SSO callback hook before user resolution,
    // so only a sign-in that Intar started for this provider reaches here.
    if (ssoIntent?.kind !== "sign-in" || ssoIntent.providerId !== providerId) {
      return ssoRejection("sso_flow_invalid");
    }

    switch (data.source.action) {
      case "sign-in": {
        const account = targetUserId
          ? await ssoSignInState(targetUserId, providerId)
          : null;
        if (!account?.active) {
          return rejectIdentity(
            "access_revoked",
            "This account no longer has access",
          );
        }
        if (account.removed) {
          return ssoRejection("sso_removed_from_organization");
        }
        if (!account.allowed) {
          return ssoRejection("sso_admin_sign_in_forbidden");
        }
        noteCallback(context, { signInProvider: providerId });
        return undefined;
      }
      case "create-user": {
        const refused = await checkSsoSignUp({
          providerId,
          email: typeof data.user.email === "string" ? data.user.email : undefined,
          profile: data.source.sso?.profile,
        });
        if (!refused) noteCallback(context, { signInProvider: providerId });
        return refused;
      }
      case "link-account": {
        // The provider's email belongs to an account this identity is not
        // connected to. An address match never links an account someone can
        // sign in to; an account with no usable identity may be reclaimed.
        const [account, identity] = targetUserId
          ? await Promise.all([
              ssoSignInState(targetUserId, providerId),
              identityState(targetUserId),
            ])
          : [null, null];
        if (!targetUserId || !account?.active || !identity) {
          return ssoRejection("sso_email_in_use");
        }
        if (account.removed) {
          return ssoRejection("sso_removed_from_organization");
        }
        const refused = await checkSsoReclaim({
          providerId,
          userId: targetUserId,
          identity,
          email: typeof data.user.email === "string" ? data.user.email : undefined,
          profile: data.source.sso?.profile,
        });
        if (!refused) {
          noteCallback(context, {
            signInProvider: providerId,
            linkedUserId: targetUserId,
          });
        }
        return refused;
      }
    }
  }

  return rejectIdentity("provider_authentication_required");
}

function buildAuthInstance() {
  assertNoAdditionalBetterAuthTrustedOrigins(
    typeof process === "undefined"
      ? undefined
      : process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  );
  assertNoAdditionalBetterAuthTrustedOrigins(
    (env as unknown as Record<string, unknown>)[
      "BETTER_AUTH_TRUSTED_ORIGINS"
    ],
  );
  const oauthProviderPlugin = oauthProvider({
    loginPage: "/",
    consentPage: "/oauth/consent",
    scopes: [...oauthScopes],
    grantTypes: ["authorization_code", "refresh_token"],
    silenceWarnings: {
      oauthAuthServerConfig: true,
      openidConfig: true,
    },
    advertisedMetadata: {
      scopes_supported: [...oauthScopes],
      claims_supported: [...oauthAdvertisedClaims],
    },
    clientPrivileges: ({ user }) =>
      isAdminRole(
        getUserRole(user as { role?: string | null | undefined } | undefined),
      ),
    customUserInfoClaims: ({ user, scopes }) =>
      getOAuthRoleClaims(user, scopes),
    customIdTokenClaims: ({ user, scopes }) => getOAuthRoleClaims(user, scopes),
    customAccessTokenClaims: async ({ user, scopes, resources }) =>
      user
        ? getOAuthAccessTokenClaims({ user, scopes, resources })
        : {},
    // Runs before the provider persists any access/refresh token for both
    // authorization-code and refresh grants, including opaque-token flows.
    // Refresh tokens use the provider defaults: the stored hash covers the
    // complete presented token.
    customTokenResponseFields: async ({ user, grantType }) => {
      if (!user) return {};
      // Tokens need an account that can still sign in, like sessions.
      if (!(await canSignIn(user.id))) {
        throwAccessError("access_revoked");
      }
      await oauthIssuanceState.set({
        userId: user.id,
        refreshGrant: grantType === "refresh_token",
      });
      return {};
    },
  }) as unknown as BetterAuthPlugin;

  return betterAuth({
    appName:
      authSetting("BETTER_AUTH_APP_NAME") ??
      "Astro App",
    baseURL,
    database: createOidcSsoAdapterFactory(
      drizzleAdapter(db, { provider: "sqlite", schema }),
    ),
    // Tenant IdP endpoints are server-side fetch targets, not trusted browser
    // origins. Public OIDC endpoints pass the SSO plugin's fetch checks without
    // widening Better Auth's redirect and Origin allowlist.
    trustedOrigins: [trustedBrowserOrigin(baseURL)],
    // Better Auth has global and per-instance log paths that can include raw
    // IdP response objects. App-owned boundaries emit fixed events instead.
    logger: { disabled: true },
    // Bubble non-redirect failures to the app-owned callback boundary before
    // BetterCall can log an upstream object or synthesize a detailed response.
    // Failures before a flow's own error URL is known (a missing or expired
    // state) land on the landing page, which explains their codes, instead of
    // Better Auth's built-in page. Organization flows reroute in
    // oidc-callback-error.ts.
    onAPIError: { throw: true, errorURL: `${trustedBrowserOrigin(baseURL)}/` },
    advanced: authCookiePolicy(baseURL),
    hooks: {
      before: accountAccessBeforeRequest,
      after: accountAccessAfterRequest,
    },
    disabledPaths: [
      "/token",
      "/sign-up/email",
      "/sign-in/email",
      "/sign-in/username",
      "/change-password",
      "/delete-user",
      "/delete-user/callback",
      "/update-user",
      "/unlink-account",
      "/admin/create-user",
      "/admin/list-users",
      "/admin/ban-user",
      "/admin/unban-user",
      "/admin/remove-user",
      "/admin/set-role",
      "/admin/update-user",
      "/admin/set-user-password",
      "/organization/create",
      "/organization/update",
      "/organization/delete",
      "/organization/leave",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/remove-member",
      "/organization/update-member-role",
      "/organization/create-role",
      "/organization/update-role",
      "/organization/delete-role",
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
    ],
    emailAndPassword: {
      enabled: false,
      disableSignUp: true,
    },
    session: { freshAge: RECENT_SIGN_IN_SECONDS },
    account: {
      accountLinking: {
        enabled: true,
        // Implicit links still reach validateUserInfo, which admits them
        // only into an account nobody can sign in to.
        disableImplicitLinking: false,
        // Provider identifiers and signed link intents bind explicit account
        // links; an address match is not an authorization boundary.
        allowDifferentEmails: true,
        // validateProviderIdentity decides which accounts a sign-in may
        // reclaim: GitHub only one whose address Intar verified, an
        // organization one its sign-up rules would have admitted.
        requireLocalEmailVerified: false,
        // Connecting another sign-in method keeps the name and avatar.
        updateUserInfoOnLink: false,
      },
    },
    user: {
      validateUserInfo: (data, context) =>
        validateProviderIdentity(data, context),
      additionalFields: {
        // Set only by an organization sign-up's create hook.
        signupOrganizationId: {
          type: "string",
          required: false,
          returned: false,
          input: false,
        },
      },
    },
    socialProviders: {
      github: {
        clientId: authSetting("GITHUB_CLIENT_ID") ?? "",
        clientSecret: authSetting("GITHUB_CLIENT_SECRET") ?? "",
        mapProfileToUser: (profile) => ({
          username: profile.login,
          displayUsername: profile.login,
        }),
      },
    },
    // The create hooks throw an APIError to refuse: returning false would let
    // Better Auth continue with a generic, unexplained failure. The update
    // hook returns false on purpose, to skip one write.
    databaseHooks: {
      user: {
        create: {
          // An organization sign-up names its new user here, so the account
          // hook admits the SSO account only for the user this request made.
          // After-create hooks run too late for that: Better Auth queues them
          // until the account exists.
          before: async (user, context) => {
            const intent = ssoIntentFromState(await readOAuthState());
            if (intent?.kind !== "sign-in") return;
            const id = createAppId();
            noteCallback(context, { createdUserId: id });
            const name =
              typeof user.name === "string" && user.name.trim()
                ? user.name
                : emailLocalPart(user.email);
            // checkSsoSignUp admitted the address: it is on the provider's
            // DNS-verified domain, or an approved provider verified it. Only
            // the first is recorded as verified, which lets a later GitHub
            // sign-in with it reclaim the account if its organization identity
            // goes away. An approved provider's other addresses stay
            // unverified, so it can't set up an account for someone else's
            // address that their own sign-in would then land in: only its
            // organization may reclaim those.
            const signUp = await organizationSignUpFields(
              intent.providerId,
              user.email,
            );
            return { data: { id, name, ...signUp } };
          },
        },
        update: {
          // trustEmailVerified would also let every organization sign-in mark
          // an existing account's address verified, past the rules that admit
          // the provider's addresses. Only an organization sign-up records it.
          before: async (user, context) => {
            const provider = callbackNote(context).signInProvider;
            return user.emailVerified === true && provider && provider !== "github"
              ? false
              : undefined;
          },
        },
      },
      account: {
        create: {
          before: async (account, context) => {
            if (!context) {
              throwAccessError(
                "account_context_missing",
                "Account links require an endpoint context",
              );
            }
            const state = await readOAuthState();
            const identity = await identityState(account.userId);
            if (account.providerId === "github") {
              if (identity.github) {
                refuseAccountInsert(
                  context,
                  state,
                  "github_already_connected",
                  "This account already has a GitHub account",
                );
              }
              // Outside Profile's explicit link, only a sign-up or a reclaim
              // of an account nobody can sign in to adds GitHub here.
              if (!isRecord(state) || !isRecord(state.link)) {
                if (!identity.reclaimable) {
                  refuseAccountInsert(
                    context,
                    state,
                    "explicit_github_link_required",
                    "An Intar account already uses this email. Sign in to it, then connect GitHub from your profile.",
                  );
                }
              }
              await reserveFirstIdentitySpot(
                context,
                state,
                account.userId,
                identity.linked,
              );
              return;
            }
            // Explicit organization links insert their account in the SSO
            // callback hook. Here a sign-in Intar started for this provider
            // may give an account its first usable identity: the user its
            // sign-up just created, or an account nobody can sign in to that
            // validateUserInfo let it reclaim.
            const intent = ssoIntentFromState(state);
            const createdHere =
              callbackNote(context).createdUserId === account.userId;
            try {
              if (
                intent?.kind !== "sign-in" ||
                intent.providerId !== account.providerId ||
                (!createdHere && !identity.reclaimable)
              ) {
                throwAccessError(
                  "explicit_sso_link_required",
                  "Connect your organization from a signed-in account",
                );
              }
              await reserveFirstIdentitySpot(
                context,
                state,
                account.userId,
                identity.linked,
              );
            } catch (error) {
              // D1 has no transactions: a refused sign-up removes the user row
              // it just created, so its address stays free.
              if (createdHere) await deleteUnclaimedSsoUser(account.userId);
              throw error;
            }
          },
          after: async (account, context) => {
            // The before hook refuses an insert without an endpoint context.
            const note = callbackNote(context);
            // The linked account now holds the spot; the reservation stops
            // counting either way, so a failed clear is only logged.
            if (note.reservedFor === account.userId) {
              try {
                await clearSignupReservation({ userId: account.userId });
              } catch (error) {
                console.warn(
                  JSON.stringify({
                    event: "signup_reservation_clear_failed",
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
              }
            }
            // An organization sign-in's identity lands after its checks. If
            // the provider was removed in between, its removal already
            // deleted the provider's identities, so this one goes too, with
            // the user a sign-up just made: otherwise it would hold a sign-up
            // spot for a provider that no longer exists. Better Auth runs this
            // hook even when the callback then failed.
            if (
              account.providerId !== "github" &&
              !(await env.DB.prepare(
                "SELECT 1 AS present FROM sso_provider WHERE provider_id = ?1",
              )
                .bind(account.providerId)
                .first())
            ) {
              await env.DB.batch([
                env.DB.prepare(
                  "DELETE FROM account WHERE id = ?1 AND provider_id = ?2",
                ).bind(account.id, account.providerId),
                // This callback may already have opened a session, which
                // can't act without an identity; the throw below skips the
                // session hooks that would remove it.
                env.DB.prepare(
                  `DELETE FROM session WHERE user_id = ?1
                     AND impersonated_by IS NULL
                     AND NOT ${usableIdentityExistsSql("?1")}`,
                ).bind(account.userId),
              ]);
              if (note.createdUserId === account.userId) {
                await deleteUnclaimedSsoUser(account.userId);
              }
              throwAccessError(
                "sso_flow_invalid",
                SSO_ERROR_MESSAGES.sso_flow_invalid,
              );
            }
            // Better Auth links the GitHub account after the callback's
            // session check, without a guard of its own: a sign-out that
            // landed in between wins, and the new identity goes.
            if (
              account.providerId === "github" &&
              note.linkSessionId &&
              !(await env.DB.prepare("SELECT 1 AS live FROM session WHERE id = ?1")
                .bind(note.linkSessionId)
                .first())
            ) {
              await env.DB.prepare(
                "DELETE FROM account WHERE id = ?1 AND provider_id = 'github'",
              )
                .bind(account.id)
                .run();
              throwAccessError(
                "link_session_ended",
                SSO_ERROR_MESSAGES.link_session_ended,
              );
            }
            if (note.linkedUserId === account.userId) {
              if (account.providerId === "github" && note.githubLogin) {
                await adoptGithubUsername(account.userId, note.githubLogin);
              }
              recordSecurityEvent(context?.request, {
                event: "security.identity_linked",
                outcome: "accepted",
                userId: account.userId,
              });
            }
          },
        },
      },
      session: {
        create: {
          // The admin plugin's banned-user check runs before this hook.
          before: async (session: Session, context) => {
            if (!(await sessionAccountAllowed(session, context))) {
              throwAccessError("access_revoked");
            }
          },
          after: async (session: Session, context) => {
            await enforceCreatedSessionStillActive(session, context);
            recordSecurityEvent(context?.request, {
              event: "security.session_created", outcome: "accepted",
              userId: session.userId,
            });
          },
        },
      },
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        usernameValidator: isValidGithubUsername,
        usernameNormalization: (value) =>
          normalizeGithubUsername(value) ?? value,
        validationOrder: { username: "post-normalization" },
        immutableUsername: true,
      }),
      admin(),
      organization({
        allowUserToCreateOrganization: async (user) =>
          canCreateOrganization(user.id),
        organizationLimit: async (user) =>
          hasReachedOwnedOrganizationLimit(user.id),
      }),
      sso({
        providersLimit: 0,
        schema: {
          ssoProvider: {
            additionalFields: {
              // Better Auth needs the column in its adapter schema so the
              // decorator can decrypt it. `returned` and `input` keep it out
              // of plugin responses and disabled plugin write endpoints.
              oidcClientSecretCiphertext: {
                type: "string",
                required: false,
                returned: false,
                input: false,
              },
            },
          },
        },
        domainVerification: {
          enabled: true,
          tokenPrefix: "intar-oidc",
        },
        // Off the verified domain Better Auth refuses an email match before
        // validateUserInfo runs unless the provider verified the address.
        // validateUserInfo admits such a match only into an account nobody can
        // sign in to, under the sign-up rules, so reclaims can reach it.
        trustEmailVerified: true,
        // The verified provider, not the user's email suffix, owns access.
        // Custom provisioning also prevents an ordinary GitHub callback from
        // joining an organization through the SSO plugin's domain hook.
        organizationProvisioning: { disabled: true },
        // Signing in through an organization's provider makes the person a
        // member, unless an admin removed them. Inactive accounts never gain
        // organization tenancy.
        provisionUserOnEveryLogin: true,
        provisionUser: async ({ user, provider }) => {
          if (!provider.organizationId) return;
          await provisionOrganizationMember({
            userId: user.id,
            organizationId: provider.organizationId,
          });
        },
        // Added by patches/@better-auth%2Fsso@1.7.0-beta.10.patch. A login its
        // organization removed goes no further. An explicit link binds the
        // verified identity to the signed-in account before the plugin
        // resolves a user by subject or email.
        beforeOIDCUserResolution: async ({
          context,
          provider,
          stateData,
          userInfo,
        }) => {
          const login = { context, provider, stateData, subject: String(userInfo.id) };
          return (await removedLoginRedirect(login)) ?? completeSsoLink(login);
        },
      }),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          jwksPath: "/.well-known/jwks.json",
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
        },
        // The clean baseline predates Better Auth's optional jwks.alg/crv
        // columns. Preserve that table during this pure replacement and map
        // its configured, single-algorithm keys without a core-schema change.
        adapter: {
          getJwks: async () =>
            (await db.select().from(schema.jwks)).map(
              ({ expiresAt, ...key }) => ({
                ...key,
                ...(expiresAt ? { expiresAt } : {}),
                alg: "EdDSA" as const,
                crv: "Ed25519" as const,
              }),
            ),
          createJwk: async (key) => {
            const id = createAppId();
            await db.insert(schema.jwks).values({
              id,
              publicKey: key.publicKey,
              privateKey: key.privateKey,
              createdAt: key.createdAt,
              ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
            });
            return {
              ...key,
              id,
              alg: "EdDSA" as const,
              crv: "Ed25519" as const,
            };
          },
        },
      }),
      oauthProviderPlugin,
    ],
    secret: authSetting("BETTER_AUTH_SECRET"),
  });
}

export function authCookiePolicy(baseUrl: string): {
  useSecureCookies: boolean;
  defaultCookieAttributes: {
    httpOnly: true;
    path: "/";
    sameSite: "lax";
    secure: boolean;
  };
} {
  const local = isLocalhostBaseUrl(baseUrl);
  return {
    // No domain attribute means host-only cookies. Local HTTP keeps the
    // development exception explicit; every other base URL fails secure.
    useSecureCookies: !local,
    defaultCookieAttributes: {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: !local,
    },
  };
}

export function trustedBrowserOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("better_auth_browser_origin_invalid");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && url.hostname === "localhost")
  ) {
    throw new Error("better_auth_browser_origin_invalid");
  }
  return url.origin;
}

export function assertNoAdditionalBetterAuthTrustedOrigins(
  value: unknown,
): void {
  if (typeof value === "string" && value.trim() !== "") {
    throw new Error("better_auth_additional_trusted_origins_forbidden");
  }
}

function isLocalhostBaseUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "localhost";
  } catch {
    return false;
  }
}

type AuthInstance = ReturnType<typeof buildAuthInstance>;

let authInstance: AuthInstance | null = null;

function getAuthInstance(): AuthInstance {
  if (!authInstance) {
    authInstance = buildAuthInstance();
  }
  return authInstance;
}

export const auth = new Proxy({} as AuthInstance, {
  get(_target, prop, receiver) {
    const instance = getAuthInstance() as object;
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
}) as AuthInstance;
