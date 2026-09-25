// Organization sign-in refusals and the one message each shows, for the server
// that refuses and the pages that explain it. Keep this module free of worker
// imports: the callback error boundary, the client, and node tests use it.

export const SSO_ERROR_MESSAGES = {
  sso_flow_invalid: "The sign-in expired or didn't match. Start again.",
  sso_email_in_use:
    "An Intar account already uses this email. Sign in to that account, then connect your organization here.",
  sso_email_unverified:
    "Your organization's identity provider hasn't verified your email address.",
  sso_email_domain_not_allowed:
    "This organization only creates accounts for emails on its verified domain. Ask an organization admin for help.",
  sso_identity_linked_elsewhere:
    "This organization identity is already connected to a different Intar account.",
  sso_identity_conflict:
    "Your Intar account is already connected to a different identity at this organization.",
  sso_removed_from_organization:
    "An organization admin removed you. Ask them to restore your access.",
  sso_admin_sign_in_forbidden:
    "Platform admins sign in with GitHub, not through an organization.",
  // Both link flows, GitHub's and organizations'.
  impersonation_link_forbidden:
    "Stop impersonating before connecting sign-in methods.",
  link_session_ended:
    "You were signed out before the connection finished. Sign in to your Intar account again, then connect it.",
} as const;

export type SsoErrorCode = keyof typeof SSO_ERROR_MESSAGES;

/** App codes the callback boundary passes through to the page as they are. */
export const APP_SIGN_IN_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(SSO_ERROR_MESSAGES),
  "signups_full",
  "access_revoked",
]);

/**
 * Every code an organization sign-in returns to a page with: an app code, or
 * the generic code the boundary gives everything else.
 */
export const ORGANIZATION_SIGN_IN_CODES: ReadonlySet<string> = new Set([
  ...APP_SIGN_IN_CODES,
  "oidc_sign_in_failed",
  "oidc_discovery_failed",
  "oidc_email_missing",
]);

// The provider's ID token carried no email, which every account needs.
export const OIDC_EMAIL_MISSING_MESSAGE =
  "Your organization's identity provider didn't send your email address. Ask its admin to include the email claim in ID tokens.";

export function ssoRejection(code: SsoErrorCode): {
  error: SsoErrorCode;
  errorDescription: string;
} {
  return { error: code, errorDescription: SSO_ERROR_MESSAGES[code] };
}

/**
 * Where a refused link returns: the flow's error URL, which Better Auth fills
 * in for every OAuth state, else its callback URL.
 */
export function linkErrorURL(state: unknown): string | null {
  const urls =
    typeof state === "object" && state !== null
      ? (state as { errorURL?: unknown; callbackURL?: unknown })
      : {};
  for (const url of [urls.errorURL, urls.callbackURL]) {
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/**
 * `url` with an error code only: pages look up the message for a code, so no
 * description travels along. A relative URL resolves against `base`.
 */
export function withErrorCode(url: string, code: string, base?: string): string {
  const target = new URL(url, base);
  target.searchParams.set("error", code);
  target.searchParams.delete("error_description");
  return target.toString();
}
