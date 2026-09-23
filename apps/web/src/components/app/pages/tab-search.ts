export type OrganizationDetailTab =
  | "overview"
  | "people"
  | "assignments"
  | "progress"
  | "servers"
  | "settings";

export type AdminPeopleTab = "users" | "signups" | "organizations";

export interface OrganizationDetailSearch {
  tab?: OrganizationDetailTab;
  oidcTest?: "passed" | "failed";
}

export interface AdminPeopleSearch {
  tab?: AdminPeopleTab;
}

export const ORGANIZATION_DETAIL_TABS: readonly OrganizationDetailTab[] = [
  "overview",
  "people",
  "assignments",
  "progress",
  "servers",
  "settings",
];

export const ADMIN_PEOPLE_TABS: readonly AdminPeopleTab[] = [
  "users",
  "signups",
  "organizations",
];

export function validateOrganizationDetailSearch(
  search: Record<string, unknown>,
): OrganizationDetailSearch {
  // SSO appends error parameters; its failure URL must not have a query string.
  if (
    search.error === "oidc_sign_in_failed" ||
    search.error === "oidc_discovery_failed"
  ) {
    return { tab: "settings", oidcTest: "failed" };
  }
  if (!isOrganizationDetailTab(search.tab) || search.tab === "overview") {
    return {};
  }
  if (
    search.tab === "settings" &&
    (search.oidcTest === "passed" || search.oidcTest === "failed")
  ) {
    return { tab: "settings", oidcTest: search.oidcTest };
  }
  return { tab: search.tab };
}

export function validateAdminPeopleSearch(
  search: Record<string, unknown>,
): AdminPeopleSearch {
  // Users is the default and stays out of the URL. Removed tabs fall back to it.
  return isAdminPeopleTab(search.tab) && search.tab !== "users"
    ? { tab: search.tab }
    : {};
}

export function isOrganizationDetailTab(
  value: unknown,
): value is OrganizationDetailTab {
  return (
    typeof value === "string" &&
    ORGANIZATION_DETAIL_TABS.includes(value as OrganizationDetailTab)
  );
}

export function isAdminPeopleTab(value: unknown): value is AdminPeopleTab {
  return (
    typeof value === "string" &&
    ADMIN_PEOPLE_TABS.includes(value as AdminPeopleTab)
  );
}
