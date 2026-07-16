export type OrganizationDetailTab =
  | "overview"
  | "scenarios"
  | "people"
  | "assignments"
  | "progress"
  | "runners"
  | "settings";

export type AdminPeopleTab = "requests" | "users" | "organizations";

export interface OrganizationDetailSearch {
  tab?: OrganizationDetailTab;
}

export interface AdminPeopleSearch {
  tab?: AdminPeopleTab;
}

export const ORGANIZATION_DETAIL_TABS: readonly OrganizationDetailTab[] = [
  "overview",
  "scenarios",
  "people",
  "assignments",
  "progress",
  "runners",
  "settings",
];

export const ADMIN_PEOPLE_TABS: readonly AdminPeopleTab[] = [
  "requests",
  "users",
  "organizations",
];

export function validateOrganizationDetailSearch(
  search: Record<string, unknown>,
): OrganizationDetailSearch {
  return isOrganizationDetailTab(search.tab) && search.tab !== "overview"
    ? { tab: search.tab }
    : {};
}

export function validateAdminPeopleSearch(
  search: Record<string, unknown>,
): AdminPeopleSearch {
  return isAdminPeopleTab(search.tab) && search.tab !== "requests"
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

export function validateScenarioBriefingSearch(
  search: Record<string, unknown>,
): { organizationId?: string } {
  return typeof search.organizationId === "string" &&
    search.organizationId.trim()
    ? { organizationId: search.organizationId.trim() }
    : {};
}

export function isAdminPeopleTab(value: unknown): value is AdminPeopleTab {
  return (
    typeof value === "string" &&
    ADMIN_PEOPLE_TABS.includes(value as AdminPeopleTab)
  );
}
