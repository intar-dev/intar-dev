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
import { account, ssoProvider, verification } from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

const VERIFICATION_PREFIX = "intar-oidc";
const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OIDC_SCOPES = ["openid", "email", "profile", "offline_access"];
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
    scopes: OIDC_SCOPES,
  });

  try {
    await db.batch([
      db.insert(ssoProvider).values({
        id: providerRowId,
        issuer,
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
    issuer,
    domain,
    domainVerified: false,
    callbackUrl: callbackUrl(input.baseUrl, providerId),
    clientIdLastFour: maskClientId(clientId),
    pkce: true,
    scopes: [...OIDC_SCOPES],
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
  const pending = provider.domainVerified
    ? null
    : await loadVerification(provider.providerId);
  return {
    providerId: provider.providerId,
    issuer: provider.issuer,
    domain: provider.domain,
    domainVerified: provider.domainVerified,
    callbackUrl: callbackUrl(params.baseUrl, provider.providerId),
    clientIdLastFour: maskClientId(clientId),
    pkce: true,
    scopes: Array.isArray(config?.scopes)
      ? config.scopes.filter(
          (value): value is string => typeof value === "string",
        )
      : [...OIDC_SCOPES],
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

export async function deleteOrganizationOidc(params: {
  organizationId: string;
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

  await db.batch([
    db
      .delete(verification)
      .where(
        eq(
          verification.identifier,
          verificationIdentifierFor(provider.providerId),
        ),
      ),
    db.delete(account).where(eq(account.providerId, provider.providerId)),
    db
      .delete(ssoProvider)
      .where(eq(ssoProvider.organizationId, params.organizationId)),
  ]);
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
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    redirect: "error",
  });
  if (!response.ok) {
    throw appError(
      502,
      "dns_lookup_failed",
      "DNS verification could not be completed; try again shortly",
    );
  }
  const body = (await response.json()) as unknown;
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
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
