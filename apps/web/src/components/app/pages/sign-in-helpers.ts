import { AuthFlowError } from "@/lib/auth-client";
import {
  OIDC_EMAIL_MISSING_MESSAGE,
  SSO_ERROR_MESSAGES,
} from "@/lib/organization-sso-errors";
import { SIGNUPS_FULL_MESSAGE } from "@/lib/signup-status";

const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;

/** The slug typed or pasted, lowercased and trimmed, or null if it isn't one. */
export function normalizeOrganizationSlug(value: string): string | null {
  const slug = value.trim().toLowerCase();
  return ORGANIZATION_SLUG_PATTERN.test(slug) ? slug : null;
}

// Messages come from the code only. The error description in a callback URL
// is never shown, so a crafted link cannot put its own words on the page.
const ORGANIZATION_SIGN_IN_MESSAGES: Record<string, string> = {
  ...SSO_ERROR_MESSAGES,
  signups_full: `${SIGNUPS_FULL_MESSAGE}.`,
  access_revoked: "This account no longer has access.",
  already_signed_in:
    "You're already signed in. Continue to connect your organization to this account.",
  organization_sso_unavailable:
    "This organization hasn't set up sign-in yet, or the link is wrong.",
  invalid_organization_slug: "Check the organization slug and try again.",
  oidc_discovery_failed:
    "Intar couldn't reach the organization's identity provider. Try again shortly.",
  oidc_email_missing: OIDC_EMAIL_MISSING_MESSAGE,
};

/**
 * `fallback` is for messages from Intar's own API; a code from a callback URL
 * gets a mapped or generic message only.
 */
export function organizationSignInErrorMessage(
  code: string | null,
  fallback?: string,
): string {
  if (code && Object.hasOwn(ORGANIZATION_SIGN_IN_MESSAGES, code)) {
    return ORGANIZATION_SIGN_IN_MESSAGES[code]!;
  }
  return fallback ?? "Organization sign-in failed. Try again.";
}

export function organizationSignInStartErrorMessage(error: unknown): string {
  return organizationSignInErrorMessage(
    error instanceof AuthFlowError ? error.code : null,
    error instanceof Error ? error.message : undefined,
  );
}

// GitHub sign-in, Connect GitHub, and app authorization return with these
// codes, from Better Auth or Intar.
const GITHUB_CALLBACK_MESSAGES: Record<string, string> = {
  signups_full:
    "No sign-up spots are open right now. Members can still sign in.",
  access_revoked: "This account no longer has access.",
  banned_user: "This account no longer has access.",
  validation_failed: "We couldn't check this sign-in. Please try again.",
  unable_to_create_session: "We couldn't complete sign-in. Please try again.",
  unable_to_create_user: "We couldn't create your account. Please try again.",
  signup_disabled: "Sign-ups are disabled for this provider.",
  state_mismatch: "Your sign-in session expired. Please try again.",
  state_not_found: "Your sign-in session expired. Please try again.",
  please_restart_the_process: "Your sign-in session expired. Please try again.",
  invalid_callback_request: "Sign-in failed. Please try again.",
  internal_server_error: "Sign-in failed. Please try again.",
  invalid_code: "GitHub sign-in was canceled or expired. Please try again.",
  no_callback_url: "Sign-in failed to return to the app. Please try again.",
  oauth_provider_not_found:
    "GitHub sign-in isn't configured. Please try again later.",
  unable_to_get_user_info: "GitHub didn't return user info. Please try again.",
  email_not_found:
    "GitHub didn't return an email. Please check your GitHub email settings.",
  // GitHub's email belongs to an existing account without this GitHub
  // identity, for example one created through organization sign-in.
  account_not_linked:
    "This email already belongs to an Intar account. Use organization sign-in if you joined through your organization, then connect GitHub from your profile.",
  explicit_github_link_required:
    "This email already belongs to an Intar account. Use organization sign-in if you joined through your organization, then connect GitHub from your profile.",
  github_account_mismatch:
    "This email belongs to an Intar account that signs in with a different GitHub account. Sign in with that one.",
  github_already_connected:
    "This Intar account already has a GitHub account connected. Sign in with that one.",
  github_flow_invalid: "The GitHub sign-in didn't match. Please try again.",
  link_session_ended: SSO_ERROR_MESSAGES.link_session_ended,
  // Intar refuses an impersonation session at an app's authorization link.
  impersonation_oauth_forbidden: "Stop impersonating before authorizing apps.",
  // The OAuth provider reports a broken app authorization link here.
  invalid_client:
    "This app's sign-in link isn't valid. Ask the app's owner to check its settings.",
  client_disabled: "This app has been disabled. Ask the app's owner for help.",
  unauthorized_client:
    "This app's sign-in link isn't valid. Ask the app's owner to check its settings.",
  invalid_redirect:
    "This app's sign-in link isn't valid. Ask the app's owner to check its settings.",
  unsupported_response_type:
    "This app's sign-in link isn't valid. Ask the app's owner to check its settings.",
};

/** The message for a GitHub callback code, or null for an unknown one. */
export function githubCallbackMessage(
  value: string | null | undefined,
): string | null {
  const key = value?.trim().toLowerCase().replace(/\s+/gu, "_");
  return key && Object.hasOwn(GITHUB_CALLBACK_MESSAGES, key)
    ? GITHUB_CALLBACK_MESSAGES[key]!
    : null;
}
