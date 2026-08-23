import {
  compactCatalogSearch,
  normalizeCatalogSearch,
  type CatalogSearch,
} from "./learn/catalog-search";

export type OrganizationDetailTab =
  | "overview"
  | "courses"
  | "people"
  | "assignments"
  | "progress"
  | "runners"
  | "settings";

export type AdminPeopleTab = "beta" | "users" | "organizations";

export interface OrganizationDetailSearch {
  tab?: OrganizationDetailTab;
  course?: string;
}

export interface AdminPeopleSearch {
  tab?: AdminPeopleTab;
}

export interface ScenarioBriefingSearch extends CatalogSearch {
  organizationId?: string;
  step?: number;
  steps?: number;
}

export const ORGANIZATION_DETAIL_TABS: readonly OrganizationDetailTab[] = [
  "overview",
  "courses",
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
  if (search.tab !== "courses") return { tab: search.tab };
  const course =
    typeof search.course === "string" && search.course.trim()
      ? search.course.trim()
      : undefined;
  return course ? { tab: "courses", course } : { tab: "courses" };
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

export function validateScenarioBriefingSearch(
  search: Record<string, unknown>,
): ScenarioBriefingSearch {
  const catalogSearch = compactCatalogSearch(normalizeCatalogSearch(search));
  const organizationId =
    typeof search.organizationId === "string" && search.organizationId.trim()
      ? search.organizationId.trim()
      : undefined;
  const step = positiveInteger(search.step);
  const steps = positiveInteger(search.steps);
  const sequence =
    step !== undefined && steps !== undefined && step <= steps
      ? { step, steps }
      : {};

  return {
    ...catalogSearch,
    ...sequence,
    ...(organizationId ? { organizationId } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function isAdminPeopleTab(value: unknown): value is AdminPeopleTab {
  return (
    typeof value === "string" &&
    ADMIN_PEOPLE_TABS.includes(value as AdminPeopleTab)
  );
}
