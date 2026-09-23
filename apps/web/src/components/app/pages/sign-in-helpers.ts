const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export function normalizeOrganizationSlug(value: string): string | null {
  const slug = value.trim();
  return ORGANIZATION_SLUG_PATTERN.test(slug) ? slug : null;
}
