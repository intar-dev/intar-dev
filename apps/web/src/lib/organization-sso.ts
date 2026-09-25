import { env } from "cloudflare:workers";
import type { GenericEndpointContext } from "@better-auth/core";
import { getSessionFromCtx } from "better-auth/api";
import {
  activeAccountExistsSql,
  type IdentityState,
  isActiveAccount,
  isImpersonatedSession,
  organizationSignInAllowedSql,
  removedFromOrganizationSql,
  removedThroughProviderSql,
  sessionMayAct,
} from "./account-access";
import { isRecord } from "@/control-plane/image-registry/shared";
import { authSetting } from "./auth-runtime";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import { createAppId } from "./id";
import {
  linkErrorURL,
  ssoRejection,
  withErrorCode,
} from "./organization-sso-errors";
import { recordSecurityEvent } from "./security-events";
import { hasOpenSignupSpot } from "./signups";
import { SIGNUPS_FULL_MESSAGE } from "./signup-status";

// Organization OIDC flows start only from Intar's own routes. Each route signs
// an intent that the Better Auth before hook stores in the OAuth state, so the
// callback knows whether it finishes a sign-in (which may create an account)
// or links the identity to the signed-in account that started the flow.

export const SSO_INTENT_HEADER = "x-intar-sso-intent";
export const SSO_INTENT_CONTEXT_KEY = "intarSsoIntent";
export const SSO_INTENT_TTL_MS = 10 * 60 * 1000;

// Intar needs only the identity claims. Refresh tokens from the identity
// provider are never used, so offline_access is not requested.
export const ORGANIZATION_SSO_SCOPES = ["openid", "email", "profile"];

const INTENT_AUDIENCE = "intar.sso-intent.v1";

export type SsoIntent =
  | { kind: "sign-in"; providerId: string; expiresAt: number }
  | { kind: "link"; providerId: string; userId: string; expiresAt: number };

type SignedSsoIntent = SsoIntent & {
  aud: typeof INTENT_AUDIENCE;
  version: 1;
};

export async function createSsoIntent(intent: SsoIntent): Promise<string> {
  const base = {
    providerId: requireSafeIdentifier(intent.providerId, "providerId"),
    expiresAt: requireIntentExpiry(intent.expiresAt),
    aud: INTENT_AUDIENCE as typeof INTENT_AUDIENCE,
    version: 1 as const,
  };
  const payload: SignedSsoIntent =
    intent.kind === "link"
      ? {
          ...base,
          kind: "link",
          userId: requireSafeIdentifier(intent.userId, "userId"),
        }
      : { ...base, kind: "sign-in" };
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await intentKey(),
    new TextEncoder().encode(`${INTENT_AUDIENCE}.${encoded}`),
  );
  return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifySsoIntent(
  value: string,
): Promise<SsoIntent | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [encoded, encodedSignature] = parts as [string, string];
  if (!encoded || !encodedSignature) return null;

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
    await intentKey(),
    copyToArrayBuffer(signature),
    new TextEncoder().encode(`${INTENT_AUDIENCE}.${encoded}`),
  );
  if (
    !validSignature ||
    !isRecord(payload) ||
    payload.aud !== INTENT_AUDIENCE ||
    payload.version !== 1 ||
    !Number.isSafeInteger(payload.expiresAt) ||
    (payload.expiresAt as number) > Date.now() + SSO_INTENT_TTL_MS
  ) {
    return null;
  }
  return parseIntent(payload);
}

/**
 * The trusted intent that the before hook stored in the OAuth state. Better
 * Auth expires that state as the intent expires, so the stored copy isn't
 * checked again: every hook of one callback reaches the same answer.
 */
export function ssoIntentFromState(state: unknown): SsoIntent | null {
  if (!isRecord(state) || !isRecord(state.serverContext)) return null;
  return parseIntent(state.serverContext[SSO_INTENT_CONTEXT_KEY], false);
}

function parseIntent(value: unknown, checkExpiry = true): SsoIntent | null {
  if (
    !isRecord(value) ||
    !isSafeIdentifier(value.providerId) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (checkExpiry && (value.expiresAt as number) <= Date.now())
  ) {
    return null;
  }
  const expiresAt = value.expiresAt as number;
  if (value.kind === "sign-in") {
    return { kind: "sign-in", providerId: value.providerId, expiresAt };
  }
  if (value.kind === "link" && isSafeIdentifier(value.userId)) {
    return {
      kind: "link",
      providerId: value.providerId,
      userId: value.userId,
      expiresAt,
    };
  }
  return null;
}

/** What an organization provider's sign-ups are admitted by. */
interface OrganizationSsoAdmission {
  organizationId: string;
  domain: string;
  domainVerified: boolean;
  allowExternalEmailSignups: boolean;
}

async function loadOrganizationSsoAdmission(
  providerId: string,
): Promise<OrganizationSsoAdmission | null> {
  const row = await env.DB
    .prepare(
      `SELECT provider.organization_id AS organizationId,
              provider.domain AS domain,
              provider.domain_verified AS domainVerified,
              coalesce(policy.allow_external_email_signups, 0) AS allowExternalEmailSignups
       FROM sso_provider AS provider
       LEFT JOIN sso_provider_policies AS policy
         ON policy.provider_id = provider.provider_id
       WHERE provider.provider_id = ?1
         AND provider.oidc_config IS NOT NULL
         AND provider.organization_id IS NOT NULL
       LIMIT 1`,
    )
    .bind(providerId)
    .first<{
      organizationId: string;
      domain: string;
      domainVerified: number;
      allowExternalEmailSignups: number;
    }>();
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    domain: row.domain,
    domainVerified: row.domainVerified === 1,
    allowExternalEmailSignups: row.allowExternalEmailSignups === 1,
  };
}

/** Same domain or a subdomain, like the SSO plugin's domain matching. */
export function emailOnDomain(email: string, domain: string): boolean {
  const at = email.lastIndexOf("@");
  const emailDomain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  const expected = domain.trim().toLowerCase();
  if (!emailDomain || !expected) return false;
  return emailDomain === expected || emailDomain.endsWith(`.${expected}`);
}

/**
 * What an organization sign-up records on its new user: the organization, and
 * whether the email is verified, which it is only on the provider's
 * DNS-verified domain. An approved provider may sign up other addresses, but
 * Intar doesn't vouch for them.
 */
export async function organizationSignUpFields(
  providerId: string,
  email: string,
): Promise<{ emailVerified: boolean; signupOrganizationId: string | null }> {
  const provider = await loadOrganizationSsoAdmission(providerId);
  return {
    emailVerified: Boolean(
      provider?.domainVerified && emailOnDomain(email, provider.domain),
    ),
    signupOrganizationId: provider?.organizationId ?? null,
  };
}

function providerEmailVerified(profile: unknown): boolean {
  if (!isRecord(profile)) return false;
  return profile.email_verified === true || profile.email_verified === "true";
}

/**
 * Decides whether an organization identity provider may create an account.
 * A verified domain makes the provider authoritative for its own addresses.
 * Other addresses need a platform admin's approval for this provider and an
 * address the provider itself verified, so a provider cannot claim emails it
 * does not control.
 */
export async function checkSsoSignUp(input: {
  providerId: string;
  email: string | undefined;
  profile: unknown;
  /** The user row a sign-in would reclaim, if any. */
  userId?: string | null;
  /** The reclaimed account already counts toward the sign-up limit. */
  spotHeld?: boolean;
}): Promise<{ error: string; errorDescription: string } | undefined> {
  // The spot check is a cheap pre-check that keeps a full limit from creating
  // user rows; the account hook's reservation is authoritative.
  const [provider, spotOpen] = await Promise.all([
    loadOrganizationSsoAdmission(input.providerId),
    input.spotHeld
      ? Promise.resolve(true)
      : hasOpenSignupSpot({ userId: input.userId ?? null }),
  ]);
  if (!provider?.domainVerified) return ssoRejection("sso_flow_invalid");
  const email = input.email ?? "";
  if (!emailOnDomain(email, provider.domain)) {
    if (!provider.allowExternalEmailSignups) {
      return ssoRejection("sso_email_domain_not_allowed");
    }
    if (!providerEmailVerified(input.profile)) {
      return ssoRejection("sso_email_unverified");
    }
  }
  if (!spotOpen) {
    return { error: "signups_full", errorDescription: SIGNUPS_FULL_MESSAGE };
  }
  return undefined;
}

/**
 * The provider's email belongs to an existing account without this identity.
 * An address never links an account someone can sign in to. An account left
 * with no usable identity (its provider was removed, or a sign-up stopped
 * between its two inserts) has no other way back, so a sign-in that could have
 * created it takes it over, under the same admission rules: when its
 * organization signed the account up, or the address is verified and on the
 * provider's verified domain. An approved provider's word alone never takes
 * over an account.
 */
export async function checkSsoReclaim(input: {
  providerId: string;
  userId: string;
  identity: IdentityState;
  email: string | undefined;
  profile: unknown;
}): Promise<{ error: string; errorDescription: string } | undefined> {
  if (!input.identity.reclaimable) return ssoRejection("sso_email_in_use");
  // An account that still has identity rows already holds a spot.
  const refused = await checkSsoSignUp({
    ...input,
    spotHeld: input.identity.linked,
  });
  if (refused) return refused;
  // An approved provider admits other addresses on its own say-so, which
  // may create an account but never take one over: not one whose address
  // another organization owns. Nor may the owner of an address take an
  // account another organization's approved provider set up with it, which
  // Intar never verified. Membership proves nothing here, since anyone can
  // connect an organization.
  const [provider, standing] = await Promise.all([
    loadOrganizationSsoAdmission(input.providerId),
    env.DB.prepare(
      `SELECT reclaimed.email_verified AS verified,
         EXISTS (SELECT 1 FROM sso_provider AS reclaiming_provider
           WHERE reclaiming_provider.provider_id = ?2
             AND reclaiming_provider.organization_id = reclaimed.signup_organization_id)
         AS signedUpHere
       FROM user AS reclaimed WHERE reclaimed.id = ?1`,
    )
      .bind(input.userId, input.providerId)
      .first<{ verified: number; signedUpHere: number }>(),
  ]);
  const ownsVerifiedAddress =
    standing?.verified === 1 &&
    Boolean(
      provider?.domainVerified &&
        emailOnDomain(input.email ?? "", provider.domain),
    );
  return ownsVerifiedAddress || standing?.signedUpHere === 1
    ? undefined
    : ssoRejection("sso_email_in_use");
}

/**
 * Whether an account is active, removed through the provider, and allowed to
 * sign in through organizations at all (see organizationSignInAllowedSql).
 */
export async function ssoSignInState(
  userId: string,
  providerId: string,
): Promise<{ active: boolean; removed: boolean; allowed: boolean }> {
  const row = await env.DB.prepare(
    `SELECT ${activeAccountExistsSql("?1")} AS active,
       ${removedThroughProviderSql("?1", "?2")} AS removed,
       ${organizationSignInAllowedSql("?1")} AS allowed`,
  )
    .bind(userId, providerId)
    .first<{ active: number; removed: number; allowed: number }>();
  return {
    active: row?.active === 1,
    removed: row?.removed === 1,
    allowed: row?.allowed === 1,
  };
}

/**
 * Removes a user row an SSO sign-up created before its account insert was
 * refused. D1 has no transactions, so this compensates; the guards keep it
 * from touching a user that holds any identity or session.
 */
export async function deleteUnclaimedSsoUser(userId: string): Promise<void> {
  try {
    await env.DB.prepare(
      `DELETE FROM user WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM account WHERE account.user_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM session WHERE session.user_id = ?1)`,
    )
      .bind(userId)
      .run();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "sso_signup_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Adds an active person the organization hasn't removed as a member. With
 * `identity`, only while that identity belongs to them.
 */
function memberInsertStatement(input: {
  userId: string;
  organizationId: string;
  identity?: { providerId: string; subject: string };
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO member (id, organization_id, user_id, role, created_at)
     SELECT ?1, ?2, ?3, 'member', ?4
     WHERE ${activeAccountExistsSql("?3")}
       AND NOT ${removedFromOrganizationSql("?3", "?2")}
       AND (?5 IS NULL OR EXISTS (SELECT 1 FROM account AS linked
         WHERE linked.provider_id = ?5 AND linked.account_id = ?6
           AND linked.user_id = ?3))
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
  ).bind(
    createAppId(),
    input.organizationId,
    input.userId,
    Date.now(),
    input.identity?.providerId ?? null,
    input.identity?.subject ?? null,
  );
}

export async function provisionOrganizationMember(input: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  await memberInsertStatement(input).run();
}

export type LinkSessionRefusal =
  | "link_session_ended"
  | "impersonation_link_forbidden"
  | "access_revoked";

/**
 * Whether a link callback still carries the session that started the link,
 * for both link flows. Better Auth's callbacks skip the before hook's session
 * check, and the session may have been signed out, or lost access, while the
 * person was at the provider.
 */
export async function checkLinkSession(
  context: GenericEndpointContext,
  userId: string,
): Promise<
  { refusal: LinkSessionRefusal } | { refusal: null; sessionId: string }
> {
  const session = await getSessionFromCtx(context, {
    disableCookieCache: true,
    disableRefresh: true,
  }).catch(() => null);
  // Signed out, or someone else signed in in the meantime; a revocation
  // signs the account out too.
  if (session?.user.id !== userId) {
    return {
      refusal: (await isActiveAccount(userId))
        ? "link_session_ended"
        : "access_revoked",
    };
  }
  // An admin impersonating someone must not leave a sign-in method of their
  // own on that account: it would outlive the impersonation.
  if (isImpersonatedSession(session.session)) {
    return { refusal: "impersonation_link_forbidden" };
  }
  // A session that may still act has an identity already, so a link never
  // takes a sign-up spot.
  if (!(await sessionMayAct(session.session))) {
    return { refusal: "access_revoked" };
  }
  return { refusal: null, sessionId: session.session.id };
}

/**
 * Where an OIDC callback ends for a login its organization removed, whichever
 * account it would sign in, create or connect to: the removal holds for the
 * login even once no account holds it. Undefined for any other login.
 */
export async function removedLoginRedirect(input: {
  context: GenericEndpointContext;
  provider: { providerId: string };
  stateData: Record<string, unknown>;
  subject: string;
}): Promise<string | undefined> {
  // The stored issuer, as the removal recorded it: the plugin hands this hook
  // a normalized copy.
  const removed = await env.DB.prepare(
    `SELECT 1 AS removed FROM organization_member_removed_logins AS removed_login
     JOIN sso_provider AS login_provider
       ON login_provider.organization_id = removed_login.organization_id
      AND login_provider.issuer = removed_login.issuer
     WHERE login_provider.provider_id = ?1 AND removed_login.subject = ?2`,
  )
    .bind(input.provider.providerId, input.subject)
    .first<{ removed: number }>();
  if (!removed) return undefined;
  return withErrorCode(
    linkErrorURL(input.stateData) ?? "/",
    "sso_removed_from_organization",
    input.context.context.baseURL,
  );
}

/**
 * Finishes an explicit link: the verified identity is bound to the signed-in
 * account that started the flow, whatever email the provider returned. Returns
 * the URL the callback redirects to, or undefined for sign-in intents so the
 * SSO plugin resolves the user as usual.
 */
export async function completeSsoLink(input: {
  context: GenericEndpointContext;
  provider: { providerId: string; organizationId?: string | null | undefined };
  stateData: Record<string, unknown>;
  subject: string;
}): Promise<string | undefined> {
  const intent = ssoIntentFromState(input.stateData);
  if (intent?.kind !== "link") return undefined;

  const callbackURL =
    typeof input.stateData.callbackURL === "string"
      ? input.stateData.callbackURL
      : null;
  const errorURL = linkErrorURL(input.stateData);
  if (!callbackURL || !errorURL) return undefined;
  const fail = (code: string) => withErrorCode(errorURL, code);

  const providerId = input.provider.providerId;
  const organizationId = input.provider.organizationId;
  if (intent.providerId !== providerId || !organizationId) {
    return fail("sso_flow_invalid");
  }
  const link = await checkLinkSession(input.context, intent.userId);
  if (link.refusal) return fail(link.refusal);
  const userId = intent.userId;

  // A platform admin may connect an organization too; its provider just
  // can't sign them in. The inserts recheck everything that may change during
  // the exchange, and the batch's last read names what did.
  const results = await env.DB.batch([
    env.DB.prepare(
      // The provider may have been removed during the token exchange: its
      // row must still belong to the organization, so a removal of the
      // person through it is still visible too. The session must still
      // exist: a removal or disconnect that signed it out meanwhile wins.
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?5
       WHERE EXISTS (SELECT 1 FROM sso_provider AS linked_provider
           WHERE linked_provider.provider_id = ?3
             AND linked_provider.organization_id = ?6)
         AND EXISTS (SELECT 1 FROM session AS linking_session
           WHERE linking_session.id = ?7 AND linking_session.user_id = ?4)
         AND ${activeAccountExistsSql("?4")}
         AND NOT ${removedThroughProviderSql("?4", "?3")}
         AND NOT EXISTS (SELECT 1 FROM account AS existing
           WHERE existing.user_id = ?4 AND existing.provider_id = ?3)
       ON CONFLICT (provider_id, account_id) DO NOTHING`,
    ).bind(
      createAppId(),
      input.subject,
      providerId,
      userId,
      Date.now(),
      organizationId,
      link.sessionId,
    ),
    memberInsertStatement({
      userId,
      organizationId,
      identity: { providerId, subject: input.subject },
    }),
    env.DB.prepare(
      `SELECT (SELECT user_id FROM account WHERE provider_id = ?2 AND account_id = ?4) AS owner,
         EXISTS (SELECT 1 FROM sso_provider WHERE provider_id = ?2) AS provider,
         EXISTS (SELECT 1 FROM session WHERE id = ?3) AS live,
         ${activeAccountExistsSql("?1")} AS active,
         ${removedThroughProviderSql("?1", "?2")} AS removed`,
    ).bind(userId, providerId, link.sessionId, input.subject),
  ]);
  const inserted = results[0]?.meta.changes === 1;
  const after = (
    results[2]?.results as
      | Array<{
          owner: string | null;
          provider: number;
          live: number;
          active: number;
          removed: number;
        }>
      | undefined
  )?.[0];

  if (after?.owner && after.owner !== userId) {
    return fail("sso_identity_linked_elsewhere");
  }
  if (!after?.provider) return fail("sso_flow_invalid");
  if (!after.active) return fail("access_revoked");
  if (!after.live) return fail("link_session_ended");
  if (after.removed) return fail("sso_removed_from_organization");
  if (!after.owner) return fail("sso_identity_conflict");
  // Connecting an identity the account already has changes nothing.
  if (inserted) {
    recordSecurityEvent(input.context.request, {
      event: "security.identity_linked",
      outcome: "accepted",
      userId,
    });
  }
  return callbackURL;
}

async function intentKey(): Promise<CryptoKey> {
  // Better Auth's own secret, so the two never diverge.
  const secret = authSetting("BETTER_AUTH_SECRET") ?? "";
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
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

function requireIntentExpiry(value: number): number {
  const now = Date.now();
  if (
    !Number.isSafeInteger(value) ||
    value <= now ||
    value > now + SSO_INTENT_TTL_MS
  ) {
    throw new Error("intent expiry is outside the allowed window");
  }
  return value;
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
