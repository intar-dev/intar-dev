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
import { validateGithubInviteLease } from "./access-invites";
import {
  getBetaAccess,
  getBetaAccessState,
  hasLinkedProviderAccount,
  isActiveBetaUser,
  isValidGithubUsername,
  toAllowlistKey,
  type BetaAccessSnapshot,
} from "./allowlist";
import { getUserRole, isAdminRole } from "./authz";
import { createAppId } from "./id";
import {
  createOidcSsoSecretAdapterFactory,
  type OidcSsoSecretAdapterRuntime,
} from "./oidc-sso-secret-adapter";
import {
  canCreateOrganization,
  hasReachedOwnedOrganizationLimit,
} from "./organization-access";

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

export const INVITE_OAUTH_HANDOFF_HEADER = "x-intar-invite-oauth-handoff";

const HANDOFF_AUDIENCE = "intar.beta-auth-handoff.v1";
const REFRESH_TOKEN_AUDIENCE = "intar.beta-refresh-token.v1";
const MAX_HANDOFF_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_ADMISSION_KEY = "intarBetaAdmission";

export type BetaAdmissionEpoch = Pick<
  BetaAccessSnapshot,
  "userId" | "sourceInviteId" | "sourceLeaseId" | "grantedAt"
>;

type ActiveBetaAdmission = BetaAccessSnapshot & { state: "active" };

type SessionIssuanceFence =
  | { kind: "active"; admission: BetaAdmissionEpoch }
  | { kind: "restricted"; flow: BetaAuthFlow };

export type GithubAccountIssuanceFence = {
  kind: "github-invite";
  inviteId: string;
  leaseId: string;
  userId: string;
};

const oauthIssuanceAdmissionState =
  defineRequestState<BetaAdmissionEpoch | null>(() => null);
const presentedRefreshAdmissionState =
  defineRequestState<BetaAdmissionEpoch | null>(() => null);

type DatabaseHookIssuanceFences = {
  sessions: Map<string, SessionIssuanceFence>;
  ssoAccounts: Map<string, BetaAdmissionEpoch>;
  githubAccounts: Map<string, GithubAccountIssuanceFence>;
};

type AccountIssuanceIdentity = {
  providerId: string;
  accountId: string;
  userId: string;
};

function accountIssuanceFenceKey(account: AccountIssuanceIdentity): string {
  return JSON.stringify([
    account.providerId,
    account.accountId,
    account.userId,
  ]);
}

// Better Auth captures one endpoint-context object for a database create and
// passes that same object to its before hook and queued after hook. Bind the
// issuance fence to that unforgeable object rather than request-state ALS:
// queued after hooks may run after the request-state scope has unwound. Account
// row ids are generated between the before and after hooks, so account fences
// use the stable provider-account-user tuple rather than the provisional id.
const databaseHookIssuanceFences = new WeakMap<
  object,
  DatabaseHookIssuanceFences
>();

function getDatabaseHookIssuanceFences(
  context: object,
): DatabaseHookIssuanceFences {
  let fences = databaseHookIssuanceFences.get(context);
  if (!fences) {
    fences = {
      sessions: new Map(),
      ssoAccounts: new Map(),
      githubAccounts: new Map(),
    };
    databaseHookIssuanceFences.set(context, fences);
  }
  return fences;
}

function readDatabaseHookIssuanceFences(
  context: object | null,
): DatabaseHookIssuanceFences | null {
  return context ? (databaseHookIssuanceFences.get(context) ?? null) : null;
}

function releaseDatabaseHookIssuanceFences(
  context: object | null,
  fences: DatabaseHookIssuanceFences | null,
): void {
  if (
    context &&
    fences &&
    fences.sessions.size === 0 &&
    fences.ssoAccounts.size === 0 &&
    fences.githubAccounts.size === 0
  ) {
    databaseHookIssuanceFences.delete(context);
  }
}

type BetaAuthFlow =
  | {
      kind: "github-invite";
      inviteId: string;
      leaseId: string;
    }
  | {
      kind: "sso-link";
      userId: string;
      providerId: string;
      expiresAt: number;
      sourceInviteId: string;
      sourceLeaseId: string;
      grantedAt: number;
    };

type HandoffEnvelope = {
  aud: typeof HANDOFF_AUDIENCE;
  expiresAt: number;
  version: 1;
};

type AdmissionBoundRefreshToken = {
  admission: BetaAdmissionEpoch;
  aud: typeof REFRESH_TOKEN_AUDIENCE;
  sessionId?: string;
  token: string;
  version: 1;
};

type HandoffPayload =
  | (Extract<BetaAuthFlow, { kind: "github-invite" }> & HandoffEnvelope)
  | (Extract<BetaAuthFlow, { kind: "sso-link" }> & HandoffEnvelope);

const rejectBetaAuth = (
  error: string,
  description = "This identity cannot be used for beta access",
) => ({ error, errorDescription: description });

const throwBetaAuthError = (
  code: string,
  message = "Beta access is required",
): never => {
  throw new APIError("FORBIDDEN", { code, message });
};

const getOAuthRoleClaims = async (user: User, scopes: readonly string[]) => {
  if (!(await isActiveBetaUser(user.id))) {
    throwBetaAuthError("beta_access_revoked");
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

export async function getBetaOAuthAccessTokenClaims(input: {
  resources?: readonly string[] | undefined;
  scopes: readonly string[];
  user: User;
}): Promise<Record<string, unknown>> {
  // oauth-provider makes access tokens self-contained JWTs whenever an RFC
  // 8707 resource/audience is requested. Those tokens cannot be revoked
  // immediately at Intar's dynamic beta boundary, so beta OAuth supports only
  // the provider's ordinary opaque access-token mode.
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

export async function createInviteOAuthHandoff(input: {
  inviteId: string;
  leaseId: string;
  leaseExpiresAt: number;
}): Promise<string> {
  return signHandoff({
    kind: "github-invite",
    inviteId: requireSafeIdentifier(input.inviteId, "inviteId"),
    leaseId: requireSafeIdentifier(input.leaseId, "leaseId"),
    expiresAt: requireHandoffExpiry(input.leaseExpiresAt),
  });
}

export async function createSsoLinkOAuthHandoff(input: {
  userId: string;
  providerId: string;
  expiresAt: number;
  sourceInviteId: string;
  sourceLeaseId: string;
  grantedAt: number;
}): Promise<string> {
  return signHandoff({
    kind: "sso-link",
    userId: requireSafeIdentifier(input.userId, "userId"),
    providerId: requireSafeIdentifier(input.providerId, "providerId"),
    sourceInviteId: requireSafeIdentifier(
      input.sourceInviteId,
      "sourceInviteId",
    ),
    sourceLeaseId: requireSafeIdentifier(input.sourceLeaseId, "sourceLeaseId"),
    grantedAt: requireSafeTimestamp(input.grantedAt, "grantedAt"),
    expiresAt: requireHandoffExpiry(input.expiresAt),
  });
}

async function signHandoff(
  flow: BetaAuthFlow & { expiresAt: number },
): Promise<string> {
  const payload: HandoffPayload = {
    ...flow,
    aud: HANDOFF_AUDIENCE,
    expiresAt: flow.expiresAt,
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

async function verifyHandoff(value: string): Promise<HandoffPayload | null> {
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
  return payload;
}

export async function createAdmissionBoundRefreshToken(input: {
  admission: BetaAdmissionEpoch;
  sessionId?: string;
  token: string;
}): Promise<string> {
  const payload: AdmissionBoundRefreshToken = {
    admission: requireAdmissionEpoch(input.admission),
    aud: REFRESH_TOKEN_AUDIENCE,
    ...(input.sessionId
      ? { sessionId: requireSafeIdentifier(input.sessionId, "sessionId") }
      : {}),
    token: requireSafeIdentifier(input.token, "token"),
    version: 1,
  };
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await handoffKey(),
    new TextEncoder().encode(`${REFRESH_TOKEN_AUDIENCE}.${encoded}`),
  );
  return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function readAdmissionBoundRefreshToken(
  value: string,
): Promise<AdmissionBoundRefreshToken> {
  const [encoded, encodedSignature, extra] = value.split(".");
  if (!encoded || !encodedSignature || extra) {
    throw new Error("invalid admission-bound refresh token");
  }

  let payload: unknown;
  let signature: Uint8Array;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encoded)),
    ) as unknown;
    signature = decodeBase64Url(encodedSignature);
  } catch {
    throw new Error("invalid admission-bound refresh token");
  }
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await handoffKey(),
    copyToArrayBuffer(signature),
    new TextEncoder().encode(`${REFRESH_TOKEN_AUDIENCE}.${encoded}`),
  );
  if (!validSignature || !isRecord(payload)) {
    throw new Error("invalid admission-bound refresh token");
  }
  const admission = readAdmissionEpoch(payload.admission);
  if (
    payload.aud !== REFRESH_TOKEN_AUDIENCE ||
    payload.version !== 1 ||
    !admission ||
    !isSafeIdentifier(payload.token) ||
    (payload.sessionId !== undefined &&
      !isSafeIdentifier(payload.sessionId))
  ) {
    throw new Error("invalid admission-bound refresh token");
  }
  return {
    admission,
    aud: REFRESH_TOKEN_AUDIENCE,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    token: payload.token,
    version: 1,
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
  if (!isRecord(value)) return false;
  if (
    value.aud !== HANDOFF_AUDIENCE ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.expiresAt) ||
    !isSafeIdentifier(value.kind)
  ) {
    return false;
  }

  switch (value.kind) {
    case "github-invite":
      return (
        isSafeIdentifier(value.inviteId) && isSafeIdentifier(value.leaseId)
      );
    case "sso-link":
      return (
        isSafeIdentifier(value.userId) &&
        isSafeIdentifier(value.providerId) &&
        isSafeIdentifier(value.sourceInviteId) &&
        isSafeIdentifier(value.sourceLeaseId) &&
        isSafeTimestamp(value.grantedAt)
      );
    default:
      return false;
  }
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

function requireSafeTimestamp(value: number, field: string): number {
  if (!isSafeTimestamp(value)) throw new Error(`${field} is invalid`);
  return value;
}

function requireAdmissionEpoch(value: BetaAdmissionEpoch): BetaAdmissionEpoch {
  const admission = readAdmissionEpoch(value);
  if (!admission) throw new Error("beta admission is invalid");
  return admission;
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function isActiveAdmission(
  access: BetaAccessSnapshot | null,
): access is ActiveBetaAdmission {
  return access?.state === "active";
}

function admissionEpoch(access: ActiveBetaAdmission): BetaAdmissionEpoch {
  return {
    userId: access.userId,
    sourceInviteId: access.sourceInviteId,
    sourceLeaseId: access.sourceLeaseId,
    grantedAt: access.grantedAt,
  };
}

function sameActiveAdmission(
  expected: BetaAdmissionEpoch,
  current: BetaAccessSnapshot | null,
): boolean {
  return (
    current?.state === "active" &&
    current.userId === expected.userId &&
    current.sourceInviteId === expected.sourceInviteId &&
    current.sourceLeaseId === expected.sourceLeaseId &&
    current.grantedAt === expected.grantedAt
  );
}

export async function captureBetaAdmissionEpoch(
  userId: string,
): Promise<BetaAdmissionEpoch> {
  const access = await getBetaAccess(userId);
  if (!isActiveAdmission(access)) {
    return throwBetaAuthError("beta_access_revoked");
  }
  return admissionEpoch(access);
}

function readAdmissionEpoch(value: unknown): BetaAdmissionEpoch | null {
  if (!isRecord(value)) return null;
  const userId = value.userId;
  const sourceInviteId = value.sourceInviteId;
  const sourceLeaseId = value.sourceLeaseId;
  const grantedAt = value.grantedAt;
  if (
    !isSafeIdentifier(userId) ||
    !isSafeIdentifier(sourceInviteId) ||
    !isSafeIdentifier(sourceLeaseId) ||
    !isSafeTimestamp(grantedAt)
  ) {
    return null;
  }
  return { userId, sourceInviteId, sourceLeaseId, grantedAt };
}

function readAuthorizationCodeValue(
  value: unknown,
): (Record<string, unknown> & { type: "authorization_code"; userId: string }) | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) &&
      parsed.type === "authorization_code" &&
      isSafeIdentifier(parsed.userId)
      ? (parsed as Record<string, unknown> & {
          type: "authorization_code";
          userId: string;
        })
      : null;
  } catch {
    return null;
  }
}

async function prepareAuthorizationCodeVerification(value: unknown): Promise<
  | {
      value: string;
      admission: BetaAdmissionEpoch;
    }
  | null
> {
  const parsed = readAuthorizationCodeValue(value);
  if (!parsed) return null;
  const admission = await captureBetaAdmissionEpoch(parsed.userId);
  return {
    value: JSON.stringify({
      ...parsed,
      [AUTHORIZATION_CODE_ADMISSION_KEY]: admission,
    }),
    admission,
  };
}

function admissionFromAuthorizationCodeVerification(
  verificationValue: unknown,
): BetaAdmissionEpoch | null {
  return isRecord(verificationValue)
    ? readAdmissionEpoch(verificationValue[AUTHORIZATION_CODE_ADMISSION_KEY])
    : null;
}

export async function captureOAuthIssuanceAdmission(input: {
  grantType: string;
  refreshAdmission?: unknown;
  userId: string;
  verificationValue?: unknown;
}): Promise<BetaAdmissionEpoch> {
  const current = await getBetaAccess(input.userId);
  if (!isActiveAdmission(current)) {
    return throwBetaAuthError("beta_access_revoked");
  }
  const expected =
    input.grantType === "authorization_code"
      ? admissionFromAuthorizationCodeVerification(input.verificationValue)
      : input.grantType === "refresh_token"
        ? readAdmissionEpoch(input.refreshAdmission)
        : null;
  if (
    !expected ||
    expected.userId !== input.userId ||
    !sameActiveAdmission(expected, current)
  ) {
    return throwBetaAuthError(
      "beta_oauth_authorization_epoch_mismatch",
      "The OAuth authorization belongs to an earlier beta admission",
    );
  }
  return expected;
}

export async function enforceOAuthIssuanceAdmission(input: {
  expected: BetaAdmissionEpoch;
  returned: unknown;
}): Promise<void> {
  const current = await getBetaAccess(input.expected.userId);
  if (sameActiveAdmission(input.expected, current)) return;

  const returned = isRecord(input.returned) ? input.returned : {};
  const accessToken =
    typeof returned.access_token === "string" ? returned.access_token : null;
  const refreshToken =
    typeof returned.refresh_token === "string" ? returned.refresh_token : null;
  try {
    await deleteExactIssuedOAuthTokens({
      userId: input.expected.userId,
      accessToken,
      refreshToken,
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      "beta access changed during OAuth issuance and issued tokens could not be removed",
    );
  }
  throwBetaAuthError(
    "beta_access_changed_during_oauth_issuance",
    "Beta access changed while the OAuth credential was being issued",
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
      "a stale beta session could not be removed",
    );
  }
}

export async function enforceCreatedSessionAdmission(input: {
  session: Session;
  expected: BetaAdmissionEpoch;
}): Promise<void> {
  if (
    sameActiveAdmission(
      input.expected,
      await getBetaAccess(input.session.userId),
    )
  ) {
    return;
  }
  await deleteExactSession(input.session);
  throwBetaAuthError(
    "beta_access_changed_during_session_creation",
    "Beta access changed while the session was being created",
  );
}

async function deleteExactLinkedAccount(account: {
  id: string;
  userId: string;
}): Promise<void> {
  let lifecycleError: unknown;
  try {
    const context = await getAuthInstance().$context;
    await context.internalAdapter.deleteAccount(account.id);
    return;
  } catch (error) {
    lifecycleError = error;
  }
  try {
    await env.DB.prepare("DELETE FROM account WHERE id = ? AND user_id = ?")
      .bind(account.id, account.userId)
      .run();
  } catch (fallbackError) {
    throw new AggregateError(
      [lifecycleError, fallbackError],
      "a stale SSO account link could not be removed",
    );
  }
}

async function enforceCreatedSsoAccountAdmission(input: {
  account: { id: string; userId: string };
  expected: BetaAdmissionEpoch;
}): Promise<void> {
  if (
    sameActiveAdmission(
      input.expected,
      await getBetaAccess(input.account.userId),
    )
  ) {
    return;
  }
  await deleteExactLinkedAccount(input.account);
  throwBetaAuthError(
    "beta_access_changed_during_sso_link",
    "Beta access changed while the SSO account was being linked",
  );
}

export async function enforceCreatedGithubAccountAdmission(input: {
  account: { id: string; providerId: string; userId: string };
  expected: GithubAccountIssuanceFence;
}): Promise<void> {
  const validTarget =
    input.account.providerId === "github" &&
    input.account.userId === input.expected.userId &&
    (await getBetaAccessState(input.account.userId)) === null;
  if (
    validTarget &&
    (await hasValidInviteLease(
      input.expected.inviteId,
      input.expected.leaseId,
    ))
  ) {
    return;
  }

  await deleteExactLinkedAccount(input.account);
  throwBetaAuthError(
    "beta_invite_changed_during_github_link",
    "The beta invitation changed while the GitHub account was being linked",
  );
}

export async function enforceCreatedAuthorizationCodeAdmission(input: {
  id: string;
  value: unknown;
}): Promise<void> {
  const parsed = readAuthorizationCodeValue(input.value);
  if (!parsed) return;
  const expected = readAdmissionEpoch(parsed[AUTHORIZATION_CODE_ADMISSION_KEY]);
  if (
    expected &&
    expected.userId === parsed.userId &&
    sameActiveAdmission(expected, await getBetaAccess(parsed.userId))
  ) {
    return;
  }

  await env.DB.prepare("DELETE FROM verification WHERE id = ? AND value = ?")
    .bind(input.id, input.value)
    .run();
  throwBetaAuthError(
    "beta_access_changed_during_oauth_authorization",
    "Beta access changed while the OAuth authorization code was being issued",
  );
}

async function hasValidInviteLease(
  inviteId: string,
  leaseId: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    await validateGithubInviteLease({
      d1: env.DB,
      inviteId,
      leaseId,
      providerId: "github",
      now,
    });
    return true;
  } catch {
    return false;
  }
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

function getTrustedBetaFlowFromState(
  state: Awaited<ReturnType<typeof getOAuthState>>,
): BetaAuthFlow | null {
  const context = state?.serverContext;
  if (!isRecord(context)) return null;
  const value = context.intarBetaAuth;
  if (!isRecord(value) || !isSafeIdentifier(value.kind)) return null;

  switch (value.kind) {
    case "github-invite":
      return isSafeIdentifier(value.inviteId) && isSafeIdentifier(value.leaseId)
        ? { kind: value.kind, inviteId: value.inviteId, leaseId: value.leaseId }
        : null;
    case "sso-link":
      return isSafeIdentifier(value.userId) &&
        isSafeIdentifier(value.providerId) &&
        Number.isSafeInteger(value.expiresAt) &&
        isSafeIdentifier(value.sourceInviteId) &&
        isSafeIdentifier(value.sourceLeaseId) &&
        isSafeTimestamp(value.grantedAt)
        ? {
            kind: value.kind,
            userId: value.userId,
            providerId: value.providerId,
            expiresAt: value.expiresAt as number,
            sourceInviteId: value.sourceInviteId,
            sourceLeaseId: value.sourceLeaseId,
            grantedAt: value.grantedAt,
          }
        : null;
    default:
      return null;
  }
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

async function isValidRestrictedSessionFlow(
  userId: string,
  flow: BetaAuthFlow | null,
): Promise<boolean> {
  if (!flow) return false;

  switch (flow.kind) {
    case "github-invite":
      return (
        (await hasValidInviteLease(flow.inviteId, flow.leaseId)) &&
        (await hasLinkedProviderAccount(userId, "github"))
      );
    case "sso-link":
      return false;
  }
}

const betaAuthBeforeRequest = createAuthMiddleware(async (context) => {
  const requestHeaders = context.request?.headers ?? context.headers;
  const session = await getSessionFromCtx(context, {
    disableCookieCache: true,
    disableRefresh: true,
  });
  const encodedHandoff = requestHeaders?.get(INVITE_OAUTH_HANDOFF_HEADER);
  let acceptedHandoff = false;

  if (encodedHandoff) {
    const handoff = await verifyHandoff(encodedHandoff);
    if (!handoff) {
      throw new APIError("FORBIDDEN", {
        code: "invalid_beta_oauth_handoff",
        message: "OAuth handoff is invalid",
      });
    }

    switch (handoff.kind) {
      case "github-invite": {
        const { inviteId, leaseId } = handoff;
        if (
          context.path !== "/sign-in/social" ||
          context.body?.provider !== "github" ||
          !(await hasValidInviteLease(inviteId, leaseId))
        ) {
          throwBetaAuthError(
            "invalid_beta_oauth_handoff",
            "OAuth handoff does not match this flow",
          );
        }
        await addOAuthServerContext({
          intarBetaAuth: { kind: handoff.kind, inviteId, leaseId },
        });
        acceptedHandoff = true;
        break;
      }
      case "sso-link": {
        const {
          expiresAt,
          grantedAt,
          providerId,
          sourceInviteId,
          sourceLeaseId,
          userId,
        } = handoff;
        const expectedAdmission: BetaAdmissionEpoch = {
          userId,
          sourceInviteId,
          sourceLeaseId,
          grantedAt,
        };
        if (
          context.path !== "/sign-in/sso" ||
          context.body?.providerId !== providerId ||
          context.body?.providerType === "saml" ||
          !(await isOidcSsoProvider(providerId)) ||
          session?.user.id !== userId ||
          !sameActiveAdmission(
            expectedAdmission,
            await getBetaAccess(userId),
          ) ||
          !(await hasLinkedProviderAccount(userId, "github"))
        ) {
          throwBetaAuthError(
            "invalid_beta_oauth_handoff",
            "OAuth handoff does not match this flow",
          );
        }
        await addOAuthServerContext({
          intarBetaAuth: {
            kind: handoff.kind,
            userId,
            providerId,
            expiresAt,
            sourceInviteId,
            sourceLeaseId,
            grantedAt,
          },
        });
        acceptedHandoff = true;
        break;
      }
    }
  }

  // Better Auth's id-token link shortcut does not invoke validateUserInfo in
  // 1.7.0-beta.10. Reject direct social links so every supported account link
  // continues through the explicit SSO-link flow and its admission fence.
  if (context.path === "/link-social" && !acceptedHandoff) {
    throwBetaAuthError("explicit_github_link_required");
  }

  if (!session?.user.id || (await isActiveBetaUser(session.user.id))) {
    return undefined;
  }

  if (
    context.path === "/get-session" ||
    context.path === "/sign-out" ||
    context.path === "/callback/github" ||
    context.path === "/sso/callback" ||
    context.path.startsWith("/sso/callback/") ||
    context.path.startsWith("/sso/saml2/sp/acs/") ||
    (acceptedHandoff &&
      (context.path === "/sign-in/social" ||
        context.path === "/link-social" ||
        context.path === "/sign-in/sso"))
  ) {
    return undefined;
  }

  return throwBetaAuthError("restricted_beta_session");
});

const betaAuthAfterRequest = createAuthMiddleware(async (context) => {
  if (context.path === "/oauth2/token") {
    const expected = await oauthIssuanceAdmissionState.get();
    if (expected) {
      await enforceOAuthIssuanceAdmission({
        expected,
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
  if (typeof subject !== "string" || (await isActiveBetaUser(subject))) {
    return undefined;
  }

  if (context.path === "/oauth2/introspect") {
    return context.json({ active: false });
  }
  throw new APIError("UNAUTHORIZED", {
    code: "beta_access_revoked",
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
  const flow = getTrustedBetaFlowFromState(state);
  const stateTargetUserId =
    typeof state?.link?.userId === "string" ? state.link.userId : null;
  const incomingUserId =
    typeof data.user.id === "string" ? data.user.id : null;
  const targetUserId =
    data.source.action === "create-user"
      ? null
      : (stateTargetUserId ?? incomingUserId);
  const access = await getBetaAccess(targetUserId);
  const accessState = access?.state ?? null;

  if (data.source.method === "oauth") {
    if (data.source.oauth?.providerId !== "github") {
      return rejectBetaAuth("unsupported_oauth_provider");
    }

    if (
      data.source.action === "create-user" &&
      flow?.kind === "github-invite" &&
      (await hasValidInviteLease(flow.inviteId, flow.leaseId))
    ) {
      return;
    }

    if (
      data.source.action === "sign-in" &&
      !flow &&
      accessState === "active"
    ) {
      return;
    }

    if (
      data.source.action === "sign-in" &&
      flow?.kind === "github-invite" &&
      (await hasValidInviteLease(flow.inviteId, flow.leaseId))
    ) {
      return;
    }

    // Better Auth classifies a GitHub callback as `link-account` when its
    // verified email matches an existing user that does not yet have this
    // GitHub identity. That is still a GitHub-authenticated invite claim, not
    // an OIDC claim: the trusted server-side OAuth state and live lease remain
    // the authority. Permit only an unadmitted target with no GitHub account;
    // the account/session database hooks re-check the same lease before either
    // linked identity or restricted session can survive.
    if (
      data.source.action === "link-account" &&
      flow?.kind === "github-invite" &&
      stateTargetUserId === null &&
      incomingUserId !== null &&
      targetUserId === incomingUserId &&
      accessState === null &&
      !(await hasLinkedProviderAccount(targetUserId, "github")) &&
      (await hasValidInviteLease(flow.inviteId, flow.leaseId))
    ) {
      return;
    }

    return rejectBetaAuth(
      data.source.action === "link-account"
        ? "explicit_github_link_required"
        : "valid_beta_invite_required",
    );
  }

  if (
    data.source.method === "sso-oidc" ||
    data.source.method === "sso-saml"
  ) {
    const providerId = data.source.sso?.providerId;
    if (!providerId) return rejectBetaAuth("sso_provider_missing");

    if (
      data.source.action === "sign-in" &&
      !flow &&
      accessState === "active"
    ) {
      return;
    }

    if (
      data.source.action === "sign-in" &&
      flow?.kind === "sso-link" &&
      flow.providerId === providerId &&
      flow.userId === targetUserId &&
      flow.expiresAt > Date.now() &&
      sameActiveAdmission(flow, access) &&
      (await hasLinkedProviderAccount(flow.userId, "github"))
    ) {
      return;
    }

    if (
      data.source.action === "link-account" &&
      flow?.kind === "sso-link" &&
      flow.providerId === providerId &&
      flow.userId === targetUserId &&
      flow.expiresAt > Date.now() &&
      sameActiveAdmission(flow, access) &&
      (await hasLinkedProviderAccount(flow.userId, "github"))
    ) {
      return;
    }

    return rejectBetaAuth(
      data.source.action === "create-user"
        ? "github_identity_required"
        : data.source.action === "link-account"
          ? "explicit_sso_link_required"
          : "valid_beta_invite_required",
    );
  }

  return rejectBetaAuth("provider_authentication_required");
}

function buildAuthInstance() {
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
        ? getBetaOAuthAccessTokenClaims({ user, scopes, resources })
        : {},
    // Runs before the provider persists any access/refresh token for both
    // authorization-code and refresh grants, including opaque-token flows.
    customTokenResponseFields: async ({
      grantType,
      user,
      verificationValue,
    }) => {
      if (!user) return {};
      const refreshAdmission =
        grantType === "refresh_token"
          ? await presentedRefreshAdmissionState.get()
          : null;
      const expected = await captureOAuthIssuanceAdmission({
        grantType,
        refreshAdmission,
        userId: user.id,
        verificationValue,
      });
      await oauthIssuanceAdmissionState.set(expected);
      return {};
    },
    // Bind the admission before Better Auth hashes and stores the refresh
    // token. The installed provider does not await formatRefreshToken.encrypt,
    // so the async request-state read must happen in this awaited generator.
    generateRefreshToken: async () => {
      const admission = await oauthIssuanceAdmissionState.get();
      if (!admission) {
        return throwBetaAuthError(
          "beta_oauth_admission_missing",
          "The OAuth refresh credential has no beta admission",
        );
      }
      return createAdmissionBoundRefreshToken({
        admission,
        token: createAppId(),
      });
    },
    formatRefreshToken: {
      // generateRefreshToken already returns the complete signed bearer. Keep
      // this callback synchronous because Better Auth 1.7.0-beta.10 does not
      // await it.
      encrypt: (token) => token,
      decrypt: async (value) => {
        let decoded: AdmissionBoundRefreshToken;
        try {
          decoded = await readAdmissionBoundRefreshToken(value);
        } catch {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_grant",
            error_description: "invalid refresh token",
          });
        }
        await presentedRefreshAdmissionState.set(decoded.admission);
        return {
          ...(decoded.sessionId ? { sessionId: decoded.sessionId } : {}),
          // The database stores the hash of the complete signed envelope.
          token: value,
        };
      },
    },
  }) as unknown as BetterAuthPlugin;

  return betterAuth({
    appName:
      runtimeEnv?.BETTER_AUTH_APP_NAME ??
      env.BETTER_AUTH_APP_NAME ??
      "Astro App",
    baseURL,
    database: createOidcSsoSecretAdapterFactory(
      drizzleAdapter(db, { provider: "sqlite", schema }),
      oidcSsoSecretRuntime,
    ),
    // Tenant IdP endpoints are server-side fetch targets, not trusted browser
    // origins. Public OIDC endpoints pass the SSO plugin's fetch checks without
    // widening Better Auth's redirect and Origin allowlist.
    trustedOrigins: [trustedBrowserOrigin(baseURL)],
    advanced: authCookiePolicy(baseURL),
    hooks: {
      before: betaAuthBeforeRequest,
      after: betaAuthAfterRequest,
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
    databaseHooks: {
      verification: {
        create: {
          before: async (verification) => {
            const prepared = await prepareAuthorizationCodeVerification(
              verification.value,
            );
            return prepared
              ? { data: { value: prepared.value } }
              : undefined;
          },
          after: async (verification) => {
            await enforceCreatedAuthorizationCodeAdmission({
              id: verification.id,
              value: verification.value,
            });
          },
        },
      },
      account: {
        create: {
          before: async (account, context) => {
            if (!context) return false;
            const flow = getTrustedBetaFlowFromState(await readOAuthState());
            const fenceKey = accountIssuanceFenceKey(account);
            if (account.providerId === "github") {
              const accessState = await getBetaAccessState(account.userId);
              const expected: GithubAccountIssuanceFence | null =
                flow?.kind === "github-invite" &&
                accessState === null &&
                !(await hasLinkedProviderAccount(account.userId, "github")) &&
                (await hasValidInviteLease(flow.inviteId, flow.leaseId))
                  ? {
                      kind: flow.kind,
                      inviteId: flow.inviteId,
                      leaseId: flow.leaseId,
                      userId: account.userId,
                    }
                  : null;
              if (!expected) return false;
              getDatabaseHookIssuanceFences(context).githubAccounts.set(
                fenceKey,
                expected,
              );
              return;
            }
            if (
              flow?.kind !== "sso-link" ||
              flow.userId !== account.userId ||
              flow.providerId !== account.providerId ||
              !sameActiveAdmission(flow, await getBetaAccess(account.userId))
            ) {
              return false;
            }
            getDatabaseHookIssuanceFences(context).ssoAccounts.set(
              fenceKey,
              flow,
            );
            return;
          },
          after: async (account, context) => {
            const fences = readDatabaseHookIssuanceFences(context);
            const fenceKey = accountIssuanceFenceKey(account);
            if (account.providerId === "github") {
              const expected = fences?.githubAccounts.get(fenceKey);
              fences?.githubAccounts.delete(fenceKey);
              releaseDatabaseHookIssuanceFences(context, fences);
              if (!expected) {
                await deleteExactLinkedAccount(account);
                return throwBetaAuthError("valid_beta_invite_required");
              }
              await enforceCreatedGithubAccountAdmission({ account, expected });
              return;
            }
            const expected = fences?.ssoAccounts.get(fenceKey);
            fences?.ssoAccounts.delete(fenceKey);
            releaseDatabaseHookIssuanceFences(context, fences);
            if (!expected) {
              await deleteExactLinkedAccount(account);
              return throwBetaAuthError("explicit_sso_link_required");
            }
            await enforceCreatedSsoAccountAdmission({ account, expected });
          },
        },
      },
      session: {
        create: {
          before: async (session: Session, context) => {
            if (!context) return false;
            const fences = getDatabaseHookIssuanceFences(context).sessions;
            const access = await getBetaAccess(session.userId);
            if (isActiveAdmission(access)) {
              fences.set(session.token, {
                kind: "active",
                admission: admissionEpoch(access),
              });
              return;
            }
            const flow = getTrustedBetaFlowFromState(await readOAuthState());
            if (!(await isValidRestrictedSessionFlow(session.userId, flow))) {
              return false;
            }
            fences.set(session.token, { kind: "restricted", flow: flow! });
            return;
          },
          after: async (session: Session, context) => {
            const issuanceFences = readDatabaseHookIssuanceFences(context);
            const fence = issuanceFences?.sessions.get(session.token);
            issuanceFences?.sessions.delete(session.token);
            releaseDatabaseHookIssuanceFences(context, issuanceFences);
            if (fence?.kind === "active") {
              await enforceCreatedSessionAdmission({
                session,
                expected: fence.admission,
              });
              return;
            }
            if (
              fence?.kind === "restricted" &&
              (await isValidRestrictedSessionFlow(session.userId, fence.flow))
            ) {
              return;
            }

            await deleteExactSession(session);
            throwBetaAuthError(
              "beta_access_changed_during_session_creation",
              "Beta access changed while the session was being created",
            );
          },
        },
      },
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        usernameValidator: isValidGithubUsername,
        usernameNormalization: (value) => toAllowlistKey(value) ?? value,
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
          // Invite sign-in may create a deliberately restricted session. Do
          // not let that pre-access callback mutate organization tenancy; the
          // next normal sign-in after confirmation provisions membership.
          if (!(await isActiveBetaUser(user.id))) return;
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

function oidcSsoSecretRuntime(): OidcSsoSecretAdapterRuntime {
  return {
    encryptionKey: runtimeBinding("OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1"),
  };
}

function runtimeBinding(name: string): string | undefined {
  const nodeValue = runtimeEnv?.[name];
  if (typeof nodeValue === "string") return nodeValue;
  const workerValue = (env as unknown as Record<string, unknown>)[name];
  return typeof workerValue === "string" ? workerValue : undefined;
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
