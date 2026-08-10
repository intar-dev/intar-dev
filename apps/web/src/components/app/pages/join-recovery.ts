export type ClaimRedirectKind = "github" | "sso";

const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export function normalizeRecoveryOrganizationSlug(value: string): string | null {
  const slug = value.trim();
  return ORGANIZATION_SLUG_PATTERN.test(slug) ? slug : null;
}

export function resolveClaimRedirect(params: {
  redirectUrl: string;
  redirectKind: ClaimRedirectKind;
  expectedKind: ClaimRedirectKind;
  applicationOrigin: string;
}): URL | null {
  if (params.redirectKind !== params.expectedKind) return null;

  let redirect: URL;
  try {
    redirect = new URL(params.redirectUrl, params.applicationOrigin);
  } catch {
    return null;
  }

  if (params.expectedKind === "sso") {
    return redirect.protocol === "https:" ? redirect : null;
  }

  const applicationOrigin = new URL(params.applicationOrigin).origin;
  const allowedSameOrigin = redirect.origin === applicationOrigin;
  const allowedGithub =
    redirect.protocol === "https:" && redirect.hostname === "github.com";
  return allowedSameOrigin || allowedGithub ? redirect : null;
}
