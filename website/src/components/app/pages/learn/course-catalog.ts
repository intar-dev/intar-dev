import type {
  ScenarioCatalogWireEntry,
  ScenarioCourseWireEntry,
} from "@/lib/scenario-runs";
import { CATALOG_SORT_COMPARATORS, type CatalogSort } from "./catalog-search";

export interface CourseCatalogFilter {
  q: string;
  difficulty?: ScenarioCatalogWireEntry["difficulty"] | undefined;
  category?: string | undefined;
  tags: string[];
  sort?: CatalogSort | null | undefined;
}

export interface CourseCatalogSectionView {
  course: ScenarioCourseWireEntry;
  accessibleScenarios: ScenarioCatalogWireEntry[];
  visibleScenarios: ScenarioCatalogWireEntry[];
  totalEstimatedMinutes: number;
  solvedCount: number;
}

export type CourseCatalogDisplayUnit =
  | {
      kind: "course";
      key: string;
      weight: number;
      section: CourseCatalogSectionView;
    }
  | {
      kind: "scenario";
      key: string;
      weight: 1;
      scenario: ScenarioCatalogWireEntry;
    };

export interface CourseCatalogView {
  units: CourseCatalogDisplayUnit[];
  courses: CourseCatalogSectionView[];
  individualScenarios: ScenarioCatalogWireEntry[];
  individualScenarioCount: number;
  visibleScenarioCount: number;
}

export function buildCourseCatalogView(
  scenarios: readonly ScenarioCatalogWireEntry[],
  courses: readonly ScenarioCourseWireEntry[],
  filter: CourseCatalogFilter,
): CourseCatalogView {
  const scenarioById = new Map(
    scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const membership = resolveMembership(courses, scenarioById);
  const needle = filter.q.trim().toLowerCase();
  const courseSections: CourseCatalogSectionView[] = [];
  const units: CourseCatalogDisplayUnit[] = [];

  for (const course of courses) {
    const key = courseCatalogKey(course);
    const accessibleScenarios = course.scenarioIds.flatMap((scenarioId) => {
      if (membership.get(scenarioId) !== key) return [];
      const scenario = scenarioById.get(scenarioId);
      return scenario ? [scenario] : [];
    });
    if (!accessibleScenarios.length) continue;

    const structurallyEligible = accessibleScenarios.filter((scenario) =>
      matchesStructuredFilters(scenario, filter),
    );
    const courseTitleMatches = Boolean(
      needle && course.title.toLowerCase().includes(needle),
    );
    const visibleScenarios = courseTitleMatches
      ? structurallyEligible
      : structurallyEligible.filter((scenario) =>
          matchesScenarioSearch(scenario, needle),
        );
    if (!visibleScenarios.length) continue;

    const section = summarizeCourse(
      course,
      accessibleScenarios,
      visibleScenarios,
    );
    courseSections.push(section);
    units.push({
      kind: "course",
      key,
      weight: visibleScenarios.length,
      section,
    });
  }

  const individualScenarios = scenarios
    .filter((scenario) => !membership.has(scenario.scenarioId))
    .filter((scenario) => matchesStructuredFilters(scenario, filter))
    .filter((scenario) => matchesScenarioSearch(scenario, needle));
  if (filter.sort) {
    individualScenarios.sort(CATALOG_SORT_COMPARATORS[filter.sort]);
  }
  units.push(
    ...individualScenarios.map(
      (scenario): CourseCatalogDisplayUnit => ({
        kind: "scenario",
        key: `scenario:${scenario.scenarioId}`,
        weight: 1,
        scenario,
      }),
    ),
  );

  return {
    units,
    courses: courseSections,
    individualScenarios,
    individualScenarioCount: scenarios.filter(
      (scenario) => !membership.has(scenario.scenarioId),
    ).length,
    visibleScenarioCount: units.reduce((total, unit) => total + unit.weight, 0),
  };
}

export function courseCatalogKey(course: ScenarioCourseWireEntry): string {
  return `${course.organizationId ?? "public"}:${course.courseId}`;
}

export function courseHeadingId(course: ScenarioCourseWireEntry): string {
  return `course-${courseCatalogKey(course).replace(/[^a-zA-Z0-9_-]/g, "-")}-heading`;
}

function resolveMembership(
  courses: readonly ScenarioCourseWireEntry[],
  scenarioById: ReadonlyMap<string, ScenarioCatalogWireEntry>,
): Map<string, string> {
  const membership = new Map<string, string>();
  for (const course of courses) {
    const key = courseCatalogKey(course);
    for (const scenarioId of course.scenarioIds) {
      if (!scenarioById.has(scenarioId)) continue;
      if (course.organizationId !== null || !membership.has(scenarioId)) {
        membership.set(scenarioId, key);
      }
    }
  }
  return membership;
}

function matchesStructuredFilters(
  scenario: ScenarioCatalogWireEntry,
  filter: CourseCatalogFilter,
): boolean {
  if (filter.difficulty && scenario.difficulty !== filter.difficulty) {
    return false;
  }
  if (filter.category && scenario.category !== filter.category) return false;
  return (
    !filter.tags.length ||
    filter.tags.every((tag) => scenario.tags.includes(tag))
  );
}

function matchesScenarioSearch(
  scenario: ScenarioCatalogWireEntry,
  needle: string,
): boolean {
  if (!needle) return true;
  return (
    scenario.title.toLowerCase().includes(needle) ||
    scenario.tagline.toLowerCase().includes(needle) ||
    scenario.category.toLowerCase().includes(needle) ||
    scenario.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

function summarizeCourse(
  course: ScenarioCourseWireEntry,
  accessibleScenarios: ScenarioCatalogWireEntry[],
  visibleScenarios: ScenarioCatalogWireEntry[],
): CourseCatalogSectionView {
  return {
    course,
    accessibleScenarios,
    visibleScenarios,
    totalEstimatedMinutes: accessibleScenarios.reduce(
      (total, scenario) => total + scenario.estimatedMinutes,
      0,
    ),
    solvedCount: accessibleScenarios.filter(
      (scenario) => scenario.progress.status === "completed",
    ).length,
  };
}
