export type TeamDetailTab =
  | "overview"
  | "people"
  | "assignments"
  | "progress"
  | "settings";

export type AdminPeopleTab = "requests" | "users" | "teams";

export interface TeamDetailSearch {
  tab?: TeamDetailTab;
}

export interface AdminPeopleSearch {
  tab?: AdminPeopleTab;
}

export const TEAM_DETAIL_TABS: readonly TeamDetailTab[] = [
  "overview",
  "people",
  "assignments",
  "progress",
  "settings",
];

export const ADMIN_PEOPLE_TABS: readonly AdminPeopleTab[] = [
  "requests",
  "users",
  "teams",
];

export function validateTeamDetailSearch(
  search: Record<string, unknown>,
): TeamDetailSearch {
  return isTeamDetailTab(search.tab) && search.tab !== "overview"
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

export function isTeamDetailTab(value: unknown): value is TeamDetailTab {
  return (
    typeof value === "string" &&
    TEAM_DETAIL_TABS.includes(value as TeamDetailTab)
  );
}

export function isAdminPeopleTab(value: unknown): value is AdminPeopleTab {
  return (
    typeof value === "string" &&
    ADMIN_PEOPLE_TABS.includes(value as AdminPeopleTab)
  );
}
