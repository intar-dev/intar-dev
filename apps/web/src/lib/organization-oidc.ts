import { env } from "cloudflare:workers";
import {
  computeDiscoveryUrl,
  fetchDiscoveryDocument,
  normalizeDiscoveryUrls,
  validateDiscoveryDocument,
  validateDiscoveryUrl,
  type OIDCDiscoveryDocument,
} from "@better-auth/sso";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ssoProvider, ssoProviderPolicies, verification } from "@/db/schema";
import {
  activeAccountExistsSql,
  activeAdminSql,
  organizationSignInAllowedSql,
  usableIdentityExistsSql,
  usableIdentitySql,
} from "@/lib/account-access";
import { signOutStatements } from "@/lib/account-sign-out";
import { appError, errorChainMatches } from "@/lib/app-error";
import { encodeBase64Url } from "@/lib/base64url";
import { createAppId } from "@/lib/id";
import { providerIssuer } from "@/lib/oidc-sso-adapter";
import { ORGANIZATION_SSO_SCOPES } from "@/lib/organization-sso";
import { requireOrganizationRole } from "@/lib/organizations";
import {
  adminRequiredError,
  isActiveAdmin,
} from "@/lib/platform-admin-authority";

const VERIFICATION_PREFIX = "intar-oidc";
const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DNS_LOOKUP_TIMEOUT_MS = 10_000;
const DOMAIN_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface RegisterOrganizationOidcInput {
  organizationId: string;
  actorUserId: string;
  issuer: string;
  domain: string;
  clientId: string;
  baseUrl: string;
}

export interface OrganizationOidcView {
  providerId: string;
  issuer: string;
  domain: string;
  domainVerified: boolean;
  callbackUrl: string;
  clientIdLastFour: string;
  pkce: true;
  scopes: string[];
  /** Set by a platform admin: sign-ups may use emails off the domain. */
  allowExternalEmailSignups: boolean;
  verification: {
    host: string;
    value: string;
    expiresAt: number;
  } | null;
}

export async function registerOrganizationOidc(
  input: RegisterOrganizationOidcInput,
): Promise<OrganizationOidcView> {
  const issuer = normalizeIssuer(input.issuer);
  const domain = normalizeDomain(input.domain);
  const clientId = input.clientId.trim();
  if (!clientId || clientId.length > 512) {
    throw appError(400, "invalid_oidc_client_id", "OIDC client ID is required");
  }

  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: ssoProvider.id })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, input.organizationId))
    .limit(1);
  if (existing.length) {
    throw appError(
      409,
      "organization_oidc_exists",
      "this organization already has an OIDC provider",
    );
  }

  const discoveryEndpoint = computeDiscoveryUrl(issuer);
  let discovered: OIDCDiscoveryDocument;
  try {
    validateDiscoveryUrl(discoveryEndpoint, isSafePublicHttpsEndpoint);
    const document = await fetchDiscoveryDocument(
      discoveryEndpoint,
      10_000,
      isSafePublicHttpsEndpoint,
    );
    validateDiscoveryDocument(document, issuer);
    discovered = normalizeDiscoveryUrls(
      document,
      issuer,
      isSafePublicHttpsEndpoint,
    );
  } catch {
    // Keep upstream URLs, HTTP status text, and body excerpts out of both the
    // response and observability output.
    console.warn(JSON.stringify({ event: "oidc_discovery_failed" }));
    throw appError(400, "oidc_discovery_failed", "OIDC discovery failed");
  }

  if (
    !Array.isArray(discovered.code_challenge_methods_supported) ||
    !discovered.code_challenge_methods_supported.includes("S256") ||
    !Array.isArray(discovered.response_types_supported) ||
    !discovered.response_types_supported.includes("code")
  ) {
    throw appError(
      400,
      "unsupported_oidc_authorization_flow",
      "the identity provider must advertise authorization code flow with PKCE S256",
    );
  }
  if (
    !Array.isArray(discovered.token_endpoint_auth_methods_supported) ||
    !discovered.token_endpoint_auth_methods_supported.includes("none")
  ) {
    throw appError(
      400,
      "unsupported_oidc_token_authentication",
      "the identity provider must advertise token authentication method none for a public client",
    );
  }
  for (const endpoint of [
    discoveryEndpoint,
    discovered.authorization_endpoint,
    discovered.token_endpoint,
    discovered.jwks_uri,
    discovered.userinfo_endpoint,
  ]) {
    if (endpoint && !isSafePublicHttpsEndpoint(endpoint)) {
      throw appError(
        400,
        "unsafe_oidc_endpoint",
        "OIDC discovery returned an endpoint that is not public HTTPS",
      );
    }
  }

  const providerRowId = createAppId();
  const providerId = `org-${createAppId()}`;
  const now = Date.now();
  const verificationToken = randomToken();
  const verificationIdentifier = verificationIdentifierFor(providerId);
  const oidcConfig = JSON.stringify({
    issuer: discovered.issuer,
    clientId,
    authorizationEndpoint: discovered.authorization_endpoint,
    tokenEndpoint: discovered.token_endpoint,
    tokenEndpointAuthentication: "none",
    jwksEndpoint: discovered.jwks_uri,
    pkce: true,
    discoveryEndpoint,
    scopes: ORGANIZATION_SSO_SCOPES,
  });

  try {
    await db.batch([
      db.insert(ssoProvider).values({
        id: providerRowId,
        // ID tokens are checked against this exact value, so store what the
        // provider advertises (for example with its trailing slash).
        issuer: discovered.issuer,
        domain,
        oidcConfig,
        oidcClientSecretCiphertext: null,
        samlConfig: null,
        userId: input.actorUserId,
        providerId,
        organizationId: input.organizationId,
        domainVerified: false,
      }),
      db.insert(verification).values({
        id: createAppId(),
        identifier: verificationIdentifier,
        value: verificationToken,
        expiresAt: new Date(now + VERIFICATION_TTL_MS),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }),
    ]);
  } catch (error) {
    if (
      errorChainMatches(error, /UNIQUE constraint failed|sso_provider_.*_uidx/)
    ) {
      throw appError(
        409,
        "organization_oidc_conflict",
        "that organization or email domain already has an OIDC provider",
      );
    }
    throw error;
  }

  return {
    providerId,
    issuer: discovered.issuer,
    domain,
    domainVerified: false,
    callbackUrl: callbackUrl(input.baseUrl, providerId),
    clientIdLastFour: maskClientId(clientId),
    pkce: true,
    scopes: [...ORGANIZATION_SSO_SCOPES],
    allowExternalEmailSignups: false,
    verification: {
      host: `${verificationIdentifier}.${domain}`,
      value: verificationToken,
      expiresAt: now + VERIFICATION_TTL_MS,
    },
  };
}

export async function getOrganizationOidc(params: {
  organizationId: string;
  baseUrl: string;
}): Promise<OrganizationOidcView | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .limit(1);
  const provider = rows[0];
  if (!provider) return null;
  const config = parseRecord(provider.oidcConfig);
  const clientId = typeof config?.clientId === "string" ? config.clientId : "";
  const [pending, policies] = await Promise.all([
    provider.domainVerified ? null : loadVerification(provider.providerId),
    db
      .select({
        allowExternalEmailSignups: ssoProviderPolicies.allowExternalEmailSignups,
      })
      .from(ssoProviderPolicies)
      .where(eq(ssoProviderPolicies.providerId, provider.providerId))
      .limit(1),
  ]);
  return {
    providerId: provider.providerId,
    issuer: providerIssuer(config, provider.issuer),
    domain: provider.domain,
    domainVerified: provider.domainVerified,
    callbackUrl: callbackUrl(params.baseUrl, provider.providerId),
    clientIdLastFour: maskClientId(clientId),
    pkce: true,
    // Intar requests these scopes whatever an older row stored.
    scopes: [...ORGANIZATION_SSO_SCOPES],
    allowExternalEmailSignups:
      policies[0]?.allowExternalEmailSignups === true,
    verification: pending
      ? {
          host: `${verificationIdentifierFor(provider.providerId)}.${provider.domain}`,
          value: pending.value,
          expiresAt: pending.expiresAt,
        }
      : null,
  };
}

export async function refreshOrganizationOidcVerification(params: {
  organizationId: string;
  baseUrl: string;
}): Promise<OrganizationOidcView> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      providerId: ssoProvider.providerId,
      domainVerified: ssoProvider.domainVerified,
    })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .limit(1);
  const provider = rows[0];
  if (!provider) {
    throw appError(
      404,
      "organization_oidc_not_found",
      "OIDC provider not found",
    );
  }
  if (provider.domainVerified) {
    throw appError(
      409,
      "oidc_domain_verified",
      "the OIDC domain is already verified",
    );
  }
  const now = Date.now();
  const identifier = verificationIdentifierFor(provider.providerId);
  await db.delete(verification).where(eq(verification.identifier, identifier));
  await db.insert(verification).values({
    id: createAppId(),
    identifier,
    value: randomToken(),
    expiresAt: new Date(now + VERIFICATION_TTL_MS),
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  const view = await getOrganizationOidc(params);
  if (!view) throw new Error("OIDC provider disappeared after token refresh");
  return view;
}

export async function verifyOrganizationOidcDomain(params: {
  organizationId: string;
  baseUrl: string;
}): Promise<OrganizationOidcView> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      providerId: ssoProvider.providerId,
      domain: ssoProvider.domain,
      domainVerified: ssoProvider.domainVerified,
    })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .limit(1);
  const provider = rows[0];
  if (!provider) {
    throw appError(
      404,
      "organization_oidc_not_found",
      "OIDC provider not found",
    );
  }
  if (provider.domainVerified) {
    const view = await getOrganizationOidc(params);
    if (!view) throw new Error("verified OIDC provider disappeared");
    return view;
  }

  const identifier = verificationIdentifierFor(provider.providerId);
  const pending = await loadVerification(provider.providerId);
  if (!pending || pending.expiresAt <= Date.now()) {
    throw appError(
      409,
      "oidc_verification_expired",
      "the DNS verification token expired; create a new token and update the TXT record",
    );
  }
  const name = `${identifier}.${provider.domain}`;
  const records = await resolveTxtRecords(name);
  const expected = new Set([pending.value, `${identifier}=${pending.value}`]);
  if (!records.some((record) => expected.has(record))) {
    throw appError(
      502,
      "oidc_domain_verification_pending",
      `the expected TXT record is not visible at ${name}`,
    );
  }

  await db.batch([
    db
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(
        and(
          eq(ssoProvider.organizationId, params.organizationId),
          eq(ssoProvider.providerId, provider.providerId),
        ),
      ),
    db.delete(verification).where(eq(verification.identifier, identifier)),
  ]);
  const view = await getOrganizationOidc(params);
  if (!view) throw new Error("OIDC provider disappeared after verification");
  return view;
}

/**
 * Platform admins decide whether the provider may create accounts for emails
 * outside its verified domain. The provider must mark those emails verified.
 */
export async function setOrganizationOidcPolicy(params: {
  organizationId: string;
  actorUserId: string;
  allowExternalEmailSignups: unknown;
  baseUrl: string;
}): Promise<OrganizationOidcView> {
  if (typeof params.allowExternalEmailSignups !== "boolean") {
    throw appError(
      400,
      "invalid_sso_policy",
      "allowExternalEmailSignups must be true or false",
    );
  }
  const allow = params.allowExternalEmailSignups;
  const rows = await drizzle(env.DB)
    .select({ providerId: ssoProvider.providerId })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .limit(1);
  const provider = rows[0];
  if (!provider) {
    throw appError(
      404,
      "organization_oidc_not_found",
      "OIDC provider not found",
    );
  }
  const now = Date.now();
  // Only a change is written and audited; saving the current value again
  // leaves both alone. The write rechecks that its actor is still a platform
  // admin.
  const [written] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sso_provider_policies
         (provider_id, allow_external_email_signups, updated_by, updated_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE EXISTS (SELECT 1 FROM sso_provider WHERE provider_id = ?1)
         AND EXISTS (SELECT 1 FROM user AS policy_admin
           WHERE policy_admin.id = ?3 AND ${activeAdminSql("policy_admin")})
         AND ?2 <> coalesce((SELECT current.allow_external_email_signups
           FROM sso_provider_policies AS current WHERE current.provider_id = ?1), 0)
       ON CONFLICT (provider_id) DO UPDATE SET
         allow_external_email_signups = excluded.allow_external_email_signups,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).bind(provider.providerId, allow ? 1 : 0, params.actorUserId, now),
    env.DB.prepare(
      `INSERT INTO access_events (id, event_type, actor_user_id, reason, created_at)
       SELECT ?1, 'sso.external_email_signups_changed', ?2, ?3, ?4
       WHERE changes() = 1`,
    ).bind(
      createAppId(),
      params.actorUserId,
      `${provider.providerId}:${allow ? "on" : "off"}`,
      now,
    ),
  ]);
  if (
    written?.meta.changes !== 1 &&
    !(await isActiveAdmin(params.actorUserId, env.DB))
  ) {
    throw adminRequiredError();
  }
  const view = await getOrganizationOidc({
    organizationId: params.organizationId,
    baseUrl: params.baseUrl,
  });
  if (!view) {
    throw appError(
      404,
      "organization_oidc_not_found",
      "OIDC provider not found",
    );
  }
  return view;
}

export async function deleteOrganizationOidc(params: {
  organizationId: string;
  /** An owner or admin of the organization. */
  actorUserId: string;
  /** The remover's own session, which stays signed in. */
  currentSessionId?: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ providerId: ssoProvider.providerId })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, params.organizationId))
    .limit(1);
  const provider = rows[0];
  if (!provider) {
    throw appError(
      404,
      "organization_oidc_not_found",
      "OIDC provider not found",
    );
  }

  // Removing the provider must not lock current members out: refuse while an
  // active member has no other usable way to sign in. Platform admins sign in
  // with GitHub, so they never depend on it.
  await assertProviderRemovable(provider.providerId, params.organizationId);

  // Everyone with an identity at it is signed out in the same batch: a
  // session doesn't record which identity opened it, so any of theirs may be
  // one the provider opened. Platform admins sign in with GitHub only, so
  // they stay signed in. Every statement rechecks the guards, the members and
  // the remover's role, so a sign-in or demotion that lands in the meantime
  // turns the whole batch into a no-op instead of stranding someone.
  const removable = `${REMOVABLE_SQL} AND ${REMOVER_SQL}`;
  const bindings = [provider.providerId, params.organizationId, params.actorUserId];
  const results = await env.DB.batch([
    ...signOutStatements(
      env.DB,
      (userColumn) =>
        `${userColumn} IN (SELECT identity.user_id FROM account AS identity
           WHERE identity.provider_id = ?1)
         AND ${organizationSignInAllowedSql(userColumn)} AND ${removable}`,
      bindings,
      params.currentSessionId,
    ),
    env.DB.prepare(
      `DELETE FROM verification WHERE identifier = ?4 AND ${removable}`,
    ).bind(...bindings, verificationIdentifierFor(provider.providerId)),
    env.DB.prepare(
      `DELETE FROM account WHERE provider_id = ?1 AND ${removable}`,
    ).bind(...bindings),
    env.DB.prepare(
      `DELETE FROM sso_provider
       WHERE provider_id = ?1 AND organization_id = ?2 AND ${removable}
       RETURNING provider_id AS providerId`,
    ).bind(...bindings),
  ]);
  if (results.at(-1)?.results?.length) return;
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  await assertProviderRemovable(provider.providerId, params.organizationId);
  throw appError(
    409,
    "organization_oidc_changed",
    "the identity provider changed while it was being removed",
  );
}

// Members that can sign in only through the provider `?1` of organization
// `?2`.
const DEPENDENT_MEMBERS_WHERE = `membership.organization_id = ?2
  AND ${activeAccountExistsSql("membership.user_id")}
  AND EXISTS (SELECT 1 FROM account AS identity
    WHERE identity.user_id = membership.user_id AND identity.provider_id = ?1
      AND ${usableIdentitySql("identity")})
  AND NOT ${usableIdentityExistsSql("membership.user_id", { exceptProvider: "?1" })}`;

const REMOVABLE_SQL = `NOT EXISTS (SELECT 1 FROM member AS membership
  WHERE ${DEPENDENT_MEMBERS_WHERE})`;

// The remover `?3` is still an owner or admin of organization `?2`.
const REMOVER_SQL = `EXISTS (SELECT 1 FROM member AS remover
  WHERE remover.organization_id = ?2 AND remover.user_id = ?3
    AND remover.role IN ('owner', 'admin'))`;

async function assertProviderRemovable(
  providerId: string,
  organizationId: string,
): Promise<void> {
  const state = await env.DB.prepare(
    `SELECT count(*) AS members,
       coalesce(sum(membership.role = 'owner'), 0) AS owners
     FROM member AS membership
     WHERE ${DEPENDENT_MEMBERS_WHERE}`,
  )
    .bind(providerId, organizationId)
    .first<{ members: number; owners: number }>();
  const members = state?.members ?? 0;
  if (members > 0) {
    throw appError(
      409,
      "organization_oidc_in_use",
      dependentMembersMessage(members, state?.owners ?? 0),
    );
  }
}

// Removing them would stick, so each needs another way to sign in first.
function dependentMembersMessage(members: number, owners: number): string {
  const who =
    members === 1
      ? owners === 1
        ? "The owner signs"
        : "1 member signs"
      : `${members} members${owners > 0 ? ", including the owner," : ""} sign`;
  return `${who} in only through this identity provider. They need to connect GitHub from Profile before you can remove it.`;
}

function normalizeIssuer(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw appError(400, "invalid_oidc_issuer", "OIDC issuer must be a URL");
  }
  if (
    !isSafePublicHttpsEndpoint(raw) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw appError(
      400,
      "invalid_oidc_issuer",
      "OIDC issuer must be a public HTTPS URL without credentials, query, or fragment",
    );
  }
  return parsed.pathname === "/" ? raw.replace(/\/$/, "") : raw;
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_PATTERN.test(domain)) {
    throw appError(
      400,
      "invalid_oidc_domain",
      "email domain must be a bare public domain such as example.com",
    );
  }
  return domain;
}

export function isSafePublicHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.port && url.port !== "443") return false;
    if (!host.includes(".") || host === "localhost") return false;
    if (host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function loadVerification(providerId: string): Promise<{
  value: string;
  expiresAt: number;
} | null> {
  const rows = await drizzle(env.DB)
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, verificationIdentifierFor(providerId)))
    .limit(1);
  const row = rows[0];
  return row ? { value: row.value, expiresAt: row.expiresAt.getTime() } : null;
}

async function resolveTxtRecords(name: string): Promise<string[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  let body: unknown;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      // Workers reject redirect: "error". A redirect isn't ok, so it fails
      // like any other unusable answer.
      redirect: "manual",
      signal: AbortSignal.timeout(DNS_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("DNS lookup was not answered");
    body = await response.json();
  } catch (error) {
    // The error name tells runtime, timeout, status and parse failures apart
    // without logging upstream text.
    console.warn(
      JSON.stringify({
        event: "oidc_dns_lookup_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    throw appError(
      502,
      "dns_lookup_failed",
      "DNS verification could not be completed; try again shortly",
    );
  }
  if (typeof body !== "object" || body === null || !("Answer" in body)) {
    return [];
  }
  const answers = Array.isArray(body.Answer) ? body.Answer : [];
  return answers.flatMap((answer) => {
    if (
      typeof answer !== "object" ||
      answer === null ||
      !("data" in answer) ||
      typeof answer.data !== "string"
    ) {
      return [];
    }
    return [decodeTxtRecord(answer.data)];
  });
}

function decodeTxtRecord(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/"\s+"/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function verificationIdentifierFor(providerId: string): string {
  return `_${VERIFICATION_PREFIX}-${providerId}`;
}

function callbackUrl(baseUrl: string, providerId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/auth/sso/callback/${encodeURIComponent(providerId)}`;
}

function maskClientId(clientId: string): string {
  return clientId.length <= 4 ? "****" : `****${clientId.slice(-4)}`;
}

function randomToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

function parseRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
