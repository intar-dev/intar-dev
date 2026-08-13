const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export function normalizeOrganizationSlug(value: string): string | null {
  const slug = value.trim();
  return ORGANIZATION_SLUG_PATTERN.test(slug) ? slug : null;
}

export function resolveGithubClaimRedirect(params: {
  redirectUrl: string;
  redirectKind: string;
  applicationOrigin: string;
}): URL | null {
  if (params.redirectKind !== "github") return null;

  let redirect: URL;
  try {
    redirect = new URL(params.redirectUrl, params.applicationOrigin);
  } catch {
    return null;
  }

  const applicationOrigin = new URL(params.applicationOrigin).origin;
  const allowedSameOrigin = redirect.origin === applicationOrigin;
  const allowedGithub =
    redirect.protocol === "https:" && redirect.hostname === "github.com";
  return allowedSameOrigin || allowedGithub ? redirect : null;
}
