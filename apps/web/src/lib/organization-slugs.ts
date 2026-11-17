/** The namespace of the public scope. No organization may take it. */
export const PUBLIC_NAMESPACE = "intar";

/**
 * Slugs no organization may choose: the public namespace and the words the
 * site uses at the top of its paths, now or for its own products.
 */
export const RESERVED_ORGANIZATION_SLUGS: ReadonlySet<string> = new Set([
  PUBLIC_NAMESPACE,
  "admin",
  "agent",
  "api",
  "app",
  "auth",
  "courses",
  "docs",
  "oauth",
  "organization-sign-in",
  "organizations",
  "platform",
  "play",
  "profile",
  "public",
  "registry",
  "runs",
  "support",
  "system",
  "v2",
  "watch",
  "www",
]);

// A chosen slug: 3 to 39 characters, lowercase, digits and single hyphens.
const CHOSEN_SLUG = /^[a-z0-9][a-z0-9-]{1,37}[a-z0-9]$/;
// Organization ids are 24-character cuid2 strings without a hyphen; a slug of
// that shape could stand for another organization where either is accepted.
const ID_SHAPE = /^[a-z0-9]{24}$/;
// Any existing slug, up to the 55 characters the old generated slugs reach.
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/;

export type OrganizationSlugRefusal =
  | "invalid_organization_slug"
  | "organization_slug_reserved";

/** Why `slug` cannot be chosen for an organization, or null when it can. */
export function chosenSlugRefusal(slug: string): OrganizationSlugRefusal | null {
  if (RESERVED_ORGANIZATION_SLUGS.has(slug)) return "organization_slug_reserved";
  if (!CHOSEN_SLUG.test(slug) || slug.includes("--") || ID_SHAPE.test(slug)) {
    return "invalid_organization_slug";
  }
  return null;
}

/** Whether an organization with `slug` can publish scenarios under it. */
export function isScenarioNamespace(slug: string): boolean {
  return NAMESPACE.test(slug) && slug !== PUBLIC_NAMESPACE;
}
