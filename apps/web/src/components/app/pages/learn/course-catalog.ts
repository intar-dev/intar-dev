import type {
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireEntry,
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
  course: ScenarioCatalogCourseWireEntry;
  accessibleScenarios: ScenarioCatalogWireEntry[];
  visibleScenarios: ScenarioCatalogWireEntry[];
  totalEstimatedMinutes: number;
  solvedCount: number;
}

export interface CourseCatalogView {
  courses: CourseCatalogSectionView[];
  generalPractice: CourseCatalogSectionView | null;
  visibleScenarioCount: number;
}

export function buildCourseCatalogView(
  courses: readonly ScenarioCatalogCourseWireEntry[],
  filter: CourseCatalogFilter,
): CourseCatalogView {
  const sections: CourseCatalogSectionView[] = [];
  let generalPractice: CourseCatalogSectionView | null = null;

  for (const course of courses) {
    const section = buildCourseCatalogSection(course, filter);
    if (!section.visibleScenarios.length) continue;
    sections.push(section);

    if (course.kind === "general-practice") {
      generalPractice = section;
    }
  }

  return {
    courses: sections,
    generalPractice,
    visibleScenarioCount: sections.reduce(
      (total, section) => total + section.visibleScenarios.length,
      0,
    ),
  };
}

export function buildCourseCatalogSection(
  course: ScenarioCatalogCourseWireEntry,
  filter: CourseCatalogFilter,
): CourseCatalogSectionView {
  const needle = filter.q.trim().toLowerCase();
  const accessibleScenarios = course.scenarios;
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

  if (course.kind === "general-practice" && filter.sort) {
    visibleScenarios.sort(CATALOG_SORT_COMPARATORS[filter.sort]);
  }

  return summarizeCourse(course, accessibleScenarios, visibleScenarios);
}

export function courseCatalogKey(
  course: ScenarioCatalogCourseWireEntry,
): string {
  return course.kind === "general-practice"
    ? "general-practice"
    : `${course.organizationId ?? "public"}:${course.courseId}`;
}

export function courseHeadingId(
  course: ScenarioCatalogCourseWireEntry,
): string {
  return `course-${courseCatalogKey(course).replace(/[^a-zA-Z0-9_-]/g, "-")}-heading`;
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
  course: ScenarioCatalogCourseWireEntry,
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
