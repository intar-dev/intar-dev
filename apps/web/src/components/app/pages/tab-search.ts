export type OrganizationDetailTab =
  | "overview"
  | "people"
  | "assignments"
  | "progress"
  | "runners"
  | "settings";

export type AdminPeopleTab = "beta" | "users" | "organizations";

export interface OrganizationDetailSearch {
  tab?: OrganizationDetailTab;
}

export interface AdminPeopleSearch {
  tab?: AdminPeopleTab;
}

export const ORGANIZATION_DETAIL_TABS: readonly OrganizationDetailTab[] = [
  "overview",
  "people",
  "assignments",
  "progress",
  "runners",
  "settings",
];

export const ADMIN_PEOPLE_TABS: readonly AdminPeopleTab[] = [
  "beta",
  "users",
  "organizations",
];

export function validateOrganizationDetailSearch(
  search: Record<string, unknown>,
): OrganizationDetailSearch {
  if (!isOrganizationDetailTab(search.tab) || search.tab === "overview") {
    return {};
  }
  return { tab: search.tab };
}

export function validateAdminPeopleSearch(
  search: Record<string, unknown>,
): AdminPeopleSearch {
  return isAdminPeopleTab(search.tab) && search.tab !== "beta"
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
