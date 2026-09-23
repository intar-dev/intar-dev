import { recordSecurityEvent } from "@/lib/security-events";
import { env } from "cloudflare:workers";
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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { db } from "../db/client";
import {
  hasAnyLinkedAccount,
  hasLinkedProviderAccount,
  isActiveAccount,
} from "./account-access";
import { getUserRole, isAdminRole } from "./authz";
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
  clearSignupReservation,
  hasOpenSignupSpot,
  reserveSignupSpot,
} from "./signups";

const runtimeEnv =
  "process" in globalThis
    ? (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env
    : undefined;

const baseURL =
  runtimeEnv?.BETTER_AUTH_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:4321";

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

export const SSO_LINK_HANDOFF_HEADER = "x-intar-sso-link-handoff";

const HANDOFF_AUDIENCE = "intar.sso-link-handoff.v1";
const MAX_HANDOFF_TTL_MS = 10 * 60 * 1000;
const SSO_LINK_CONTEXT_KEY = "intarSsoLink";
const SIGNUPS_FULL_MESSAGE = "No sign-up spots are open right now";

// The user an OAuth token response is issued for. The after hook rechecks
// that account once the provider has stored the tokens.
const oauthIssuanceUserState = defineRequestState<string | null>(() => null);

type SsoLinkFlow = {
  kind: "sso-link";
  userId: string;
  providerId: string;
  expiresAt: number;
};

type HandoffPayload = SsoLinkFlow & {
  aud: typeof HANDOFF_AUDIENCE;
  version: 1;
};

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

export async function createSsoLinkOAuthHandoff(input: {
  userId: string;
  providerId: string;
  expiresAt: number;
}): Promise<string> {
  const payload: HandoffPayload = {
    kind: "sso-link",
    userId: requireSafeIdentifier(input.userId, "userId"),
    providerId: requireSafeIdentifier(input.providerId, "providerId"),
    expiresAt: requireHandoffExpiry(input.expiresAt),
    aud: HANDOFF_AUDIENCE,
    version: 1,
  };
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await handoffKey(),
    new TextEncoder().encode(`${HANDOFF_AUDIENCE}.${encoded}`),
  );
  return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyHandoff(value: string): Promise<SsoLinkFlow | null> {
  const [encoded, encodedSignature, extra] = value.split(".");
  if (!encoded || !encodedSignature || extra) return null;

  let payload: unknown;
  let signature: Uint8Array;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encoded)),
    ) as unknown;
    signature = decodeBase64Url(encodedSignature);
  } catch {
    return null;
  }

  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await handoffKey(),
    copyToArrayBuffer(signature),
    new TextEncoder().encode(`${HANDOFF_AUDIENCE}.${encoded}`),
  );
  if (!validSignature || !isHandoffPayload(payload)) return null;

  const now = Date.now();
  if (payload.expiresAt <= now || payload.expiresAt > now + MAX_HANDOFF_TTL_MS) {
    return null;
  }
  return {
    kind: payload.kind,
    userId: payload.userId,
    providerId: payload.providerId,
    expiresAt: payload.expiresAt,
  };
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function handoffKey(): Promise<CryptoKey> {
  const secret =
    runtimeEnv?.BETTER_AUTH_SECRET ?? env.BETTER_AUTH_SECRET ?? "";
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function isHandoffPayload(value: unknown): value is HandoffPayload {
  return (
    isRecord(value) &&
    value.aud === HANDOFF_AUDIENCE &&
    value.version === 1 &&
    value.kind === "sso-link" &&
    Number.isSafeInteger(value.expiresAt) &&
    isSafeIdentifier(value.userId) &&
    isSafeIdentifier(value.providerId)
  );
}

function requireSafeIdentifier(value: string, field: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`${field} is invalid`);
  return value;
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function requireHandoffExpiry(value: number): number {
  const now = Date.now();
  if (
    !Number.isSafeInteger(value) ||
    value <= now ||
    value > now + MAX_HANDOFF_TTL_MS
  ) {
    throw new Error("handoff expiry is outside the allowed window");
  }
  return value;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(decoded) !== value) {
    throw new Error("non-canonical base64url");
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs after the provider stored an OAuth token response. Access only moves
 * from active to revoked, so an account that is still active held access for
 * the whole issuance; otherwise the issued tokens are removed and the
 * response is suppressed.
 */
export async function enforceActiveOAuthIssuance(input: {
  userId: string;
  returned: unknown;
}): Promise<void> {
  if (await isActiveAccount(input.userId)) return;

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

async function hashStoredOAuthToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function deleteExactSession(session: Session): Promise<void> {
  let lifecycleError: unknown;
  try {
    const context = await getAuthInstance().$context;
    await context.internalAdapter.deleteSession(session.token);
    return;
  } catch (error) {
    lifecycleError = error;
  }

  try {
    await env.DB.prepare("DELETE FROM session WHERE token = ? AND user_id = ?")
      .bind(session.token, session.userId)
      .run();
  } catch (fallbackError) {
    throw new AggregateError(
      [lifecycleError, fallbackError],
      "a session of a revoked account could not be removed",
    );
  }
}

/**
 * Runs after a session row exists. A revocation that committed between the
 * create hook's check and the insert has already swept the sessions, so the
 * late row is removed here.
 */
export async function enforceCreatedSessionStillActive(
  session: Session,
): Promise<void> {
  if (await isActiveAccount(session.userId)) return;
  await deleteExactSession(session);
  throwAccessError(
    "access_revoked",
    "Account access was revoked while the session was being created",
  );
}

async function isOidcSsoProvider(providerId: string): Promise<boolean> {
  // Better Auth SSO 1.7.0-beta.10 preserves OAuth serverContext in OIDC
  // state, but its separate SAML RelayState omits it. Explicit account linking
  // therefore fails closed for SAML until that server-context seam exists.
  const providers = await drizzle(env.DB)
    .select({ oidcConfig: schema.ssoProvider.oidcConfig })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, providerId))
    .limit(1);
  return Boolean(providers[0]?.oidcConfig);
}

function getTrustedSsoLinkFromState(
  state: Awaited<ReturnType<typeof getOAuthState>>,
): SsoLinkFlow | null {
  const context = state?.serverContext;
  if (!isRecord(context)) return null;
  const value = context[SSO_LINK_CONTEXT_KEY];
  if (
    !isRecord(value) ||
    value.kind !== "sso-link" ||
    !isSafeIdentifier(value.userId) ||
    !isSafeIdentifier(value.providerId) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return null;
  }
  return {
    kind: "sso-link",
    userId: value.userId,
    providerId: value.providerId,
    expiresAt: value.expiresAt as number,
  };
}

function isLiveSsoLink(
  flow: SsoLinkFlow | null,
  userId: string | null,
  providerId: string,
): boolean {
  return (
    flow !== null &&
    flow.userId === userId &&
    flow.providerId === providerId &&
    flow.expiresAt > Date.now()
  );
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

const accountAccessBeforeRequest = createAuthMiddleware(async (context) => {
  // disabledPaths protects HTTP. This guard also protects direct auth.api
  // calls, including leaveOrganization, which has no member-removal hook.
  if (context.path === "/organization/leave" || context.path === "/organization/remove-member") {
    throw new APIError("FORBIDDEN", { message: "Use the application organization membership routes" });
  }
  // Better Auth's id-token link shortcut does not invoke validateUserInfo in
  // 1.7.0-beta.10. Reject direct social links: GitHub is linked only by
  // signing up with GitHub, and SSO only through the explicit SSO-link flow.
  if (context.path === "/link-social") {
    throwAccessError(
      "explicit_github_link_required",
      "GitHub can only be connected by signing up with GitHub",
    );
  }
  // Session inspection carries no credential material beyond the cookie, and
  // every protected call re-reads the account through requireUserContext.
  if (context.path === "/get-session") return undefined;

  const requestHeaders = context.request?.headers ?? context.headers;
  const encodedHandoff = requestHeaders?.get(SSO_LINK_HANDOFF_HEADER);
  const session = await getSessionFromCtx(context, {
    disableCookieCache: true,
    disableRefresh: true,
  });
  const sessionUserId = session?.user.id ?? null;
  const sessionActive = sessionUserId
    ? await isActiveAccount(sessionUserId)
    : false;

  if (encodedHandoff) {
    const handoff = await verifyHandoff(encodedHandoff);
    if (!handoff) {
      throwAccessError(
        "invalid_sso_link_handoff",
        "The SSO link handoff is invalid",
      );
    }
    const { expiresAt, providerId, userId } = handoff;
    if (
      context.path !== "/sign-in/sso" ||
      context.body?.providerId !== providerId ||
      context.body?.providerType === "saml" ||
      !(await isOidcSsoProvider(providerId)) ||
      sessionUserId !== userId ||
      !sessionActive ||
      !(await hasLinkedProviderAccount(userId, "github"))
    ) {
      throwAccessError(
        "invalid_sso_link_handoff",
        "The SSO link handoff does not match this request",
      );
    }
    await addOAuthServerContext({
      [SSO_LINK_CONTEXT_KEY]: {
        kind: "sso-link",
        userId,
        providerId,
        expiresAt,
      },
    });
  }

  if (!sessionUserId || sessionActive) return undefined;

  // A session whose account lost access may only sign out or finish a sign-in
  // callback. The identity gate checks the callback's own account.
  if (
    context.path === "/sign-out" ||
    context.path === "/callback/github" ||
    context.path === "/sso/callback" ||
    context.path.startsWith("/sso/callback/")
  ) {
    return undefined;
  }

  return throwAccessError("access_revoked");
});

const accountAccessAfterRequest = createAuthMiddleware(async (context) => {
  if (context.path === "/oauth2/token") {
    const userId = await oauthIssuanceUserState.get();
    if (userId) {
      await enforceActiveOAuthIssuance({
        userId,
        returned: context.context.returned,
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
  // this provider does not enable pairwise subjects.
  const returned = context.context.returned;
  const subject = isRecord(returned) ? returned.sub : null;
  if (typeof subject !== "string" || (await isActiveAccount(subject))) {
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
) {
  const state = await readOAuthState();
  const ssoLink = getTrustedSsoLinkFromState(state);
  const stateTargetUserId =
    typeof state?.link?.userId === "string" ? state.link.userId : null;
  const incomingUserId =
    typeof data.user.id === "string" ? data.user.id : null;
  const targetUserId =
    data.source.action === "create-user"
      ? null
      : (stateTargetUserId ?? incomingUserId);

  if (data.source.method === "oauth") {
    if (data.source.oauth?.providerId !== "github") {
      return rejectIdentity(
        "unsupported_oauth_provider",
        "Sign in with GitHub",
      );
    }
    // GitHub never completes an SSO-link flow or a stock account link.
    if (ssoLink || state?.link) {
      return rejectIdentity(
        "explicit_github_link_required",
        "GitHub can only be connected by signing up with GitHub",
      );
    }

    switch (data.source.action) {
      case "sign-in":
        return (await isActiveAccount(targetUserId))
          ? undefined
          : rejectIdentity("access_revoked", "This account no longer has access");
      case "create-user":
        // A cheap pre-check that keeps a full cap from creating account-less
        // user rows. The account hook's reservation is authoritative.
        return (await hasOpenSignupSpot({ userId: null }))
          ? undefined
          : rejectIdentity("signups_full", SIGNUPS_FULL_MESSAGE);
      case "link-account":
        // Better Auth classifies a GitHub callback as `link-account` when its
        // verified email matches an existing user without this GitHub
        // identity. Only an account-less user row, left by a sign-up that
        // lost the race for the last spot, may complete its sign-up this way.
        if (!targetUserId || !(await isActiveAccount(targetUserId))) {
          return rejectIdentity(
            "access_revoked",
            "This account no longer has access",
          );
        }
        if (await hasAnyLinkedAccount(targetUserId)) {
          return rejectIdentity(
            "explicit_github_link_required",
            "This GitHub account can't be linked to an existing account",
          );
        }
        return (await hasOpenSignupSpot({ userId: targetUserId }))
          ? undefined
          : rejectIdentity("signups_full", SIGNUPS_FULL_MESSAGE);
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
    if (data.source.action === "create-user") {
      return rejectIdentity(
        "github_identity_required",
        "Sign up with GitHub first, then connect your organization",
      );
    }
    if (
      !targetUserId ||
      !(await isActiveAccount(targetUserId)) ||
      !(await hasLinkedProviderAccount(targetUserId, "github"))
    ) {
      return rejectIdentity(
        "access_revoked",
        "This account no longer has access",
      );
    }
    if (data.source.action === "sign-in" && !ssoLink) return;
    if (isLiveSsoLink(ssoLink, targetUserId, providerId)) return;

    return rejectIdentity(
      "explicit_sso_link_required",
      "Connect your organization from a signed-in GitHub account",
    );
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
    customTokenResponseFields: async ({ user }) => {
      if (!user) return {};
      if (!(await isActiveAccount(user.id))) {
        throwAccessError("access_revoked");
      }
      await oauthIssuanceUserState.set(user.id);
      return {};
    },
  }) as unknown as BetterAuthPlugin;

  return betterAuth({
    appName:
      runtimeEnv?.BETTER_AUTH_APP_NAME ??
      env.BETTER_AUTH_APP_NAME ??
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
    onAPIError: { throw: true },
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
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        // Provider identifiers and the signed step-up intent bind explicit
        // account links; an address match is not an authorization boundary.
        allowDifferentEmails: true,
        // Explicit account linking may refresh mapped profile fields while
        // Better Auth preserves the existing primary email.
        updateUserInfoOnLink: true,
      },
    },
    user: {
      validateUserInfo: (data) => validateProviderIdentity(data),
    },
    socialProviders: {
      github: {
        clientId: runtimeEnv?.GITHUB_CLIENT_ID ?? env.GITHUB_CLIENT_ID,
        clientSecret:
          runtimeEnv?.GITHUB_CLIENT_SECRET ?? env.GITHUB_CLIENT_SECRET,
        mapProfileToUser: (profile) => ({
          username: profile.login,
          displayUsername: profile.login,
        }),
      },
    },
    // These hooks always throw an APIError to refuse. Returning false would
    // let Better Auth continue with a generic, unexplained failure.
    databaseHooks: {
      account: {
        create: {
          before: async (account, context) => {
            if (!context) {
              throwAccessError(
                "account_context_missing",
                "Account links require an endpoint context",
              );
            }
            if (account.providerId === "github") {
              if (await hasLinkedProviderAccount(account.userId, "github")) {
                throwAccessError(
                  "explicit_github_link_required",
                  "This account already has a GitHub account",
                );
              }
              // The authoritative cap: one guarded insert, so concurrent
              // sign-ups for the last spot admit exactly one.
              if (!(await reserveSignupSpot({ userId: account.userId }))) {
                throw new APIError("FORBIDDEN", {
                  code: "signups_full",
                  message: SIGNUPS_FULL_MESSAGE,
                });
              }
              return;
            }
            const flow = getTrustedSsoLinkFromState(await readOAuthState());
            if (
              !isLiveSsoLink(flow, account.userId, account.providerId) ||
              !(await isActiveAccount(account.userId)) ||
              !(await hasLinkedProviderAccount(account.userId, "github"))
            ) {
              throwAccessError(
                "explicit_sso_link_required",
                "Connect your organization from a signed-in GitHub account",
              );
            }
          },
          after: async (account) => {
            if (account.providerId !== "github") return;
            // The linked GitHub account now holds the spot; the reservation
            // stops counting either way, so a failed clear is only logged.
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
          },
        },
      },
      session: {
        create: {
          // The admin plugin's banned-user check runs before this hook.
          before: async (session: Session) => {
            if (!(await isActiveAccount(session.userId))) {
              throwAccessError("access_revoked");
            }
          },
          after: async (session: Session, context) => {
            await enforceCreatedSessionStillActive(session);
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
        // The verified provider, not the user's email suffix, owns access.
        // Custom provisioning also prevents an ordinary GitHub callback from
        // joining an organization through the SSO plugin's domain hook.
        organizationProvisioning: { disabled: true },
        provisionUserOnEveryLogin: true,
        provisionUser: async ({ user, provider }) => {
          // An account that lost access must not gain organization tenancy.
          if (!(await isActiveAccount(user.id))) return;
          if (!provider.organizationId) return;
          await db
            .insert(schema.member)
            .values({
              id: createAppId(),
              organizationId: provider.organizationId,
              userId: user.id,
              role: "member",
              createdAt: new Date(),
            })
            .onConflictDoNothing({
              target: [schema.member.organizationId, schema.member.userId],
            });
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
    secret: runtimeEnv?.BETTER_AUTH_SECRET ?? env.BETTER_AUTH_SECRET,
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
