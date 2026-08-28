import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Clock3,
  Search,
} from "lucide-react";
import {
  COLLECTION_PAGE_SIZE,
  CollectionPagination,
  PaginatedCollection,
  paginateCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Button } from "@/components/ui/button";
import type {
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireEntry,
} from "@/lib/scenario-runs";
import {
  courseCatalogKey,
  courseHeadingId,
  getCourseCurriculumState,
  type CourseCatalogSectionView,
} from "./course-catalog";
import { CourseDescription } from "./CourseDescription";

export interface CourseScenarioRendererContext {
  courseKey: string;
  courseTitle: string;
  course: ScenarioCatalogCourseWireEntry;
  /** Present only for authored courses, using the unfiltered curriculum order. */
  sequence?: {
    position: number;
    total: number;
  };
  /** The active or first unsolved step in the unfiltered curriculum. */
  isNext: boolean;
}

export function CourseCatalogBrowser({
  courses,
  selectedCourseKey,
  selectedSection,
  onSelectCourse,
  onShowAllCourses,
  onClearFilters,
  detailTools,
  renderScenario,
  resetKey,
}: {
  courses: readonly CourseCatalogSectionView[];
  selectedCourseKey?: string | undefined;
  selectedSection?: CourseCatalogSectionView | null | undefined;
  onSelectCourse: (courseKey: string) => void;
  onShowAllCourses: () => void;
  onClearFilters?: (() => void) | undefined;
  detailTools?: ReactNode;
  renderScenario: (
    scenario: ScenarioCatalogWireEntry,
    context: CourseScenarioRendererContext,
  ) => ReactNode;
  resetKey?: string | number | boolean | null;
}) {
  const [returnFocusKey, setReturnFocusKey] = useState<
    string | null | undefined
  >(undefined);
  const [indexPageState, setIndexPageState] = useState(() => ({
    page: 1,
    resetKey,
  }));
  const previousSelectedCourseKey = useRef(selectedCourseKey);
  const indexResetPending = !Object.is(indexPageState.resetKey, resetKey);
  const indexPage = paginateCollection(
    courses,
    indexResetPending ? 1 : indexPageState.page,
    COLLECTION_PAGE_SIZE.cards,
  );

  useEffect(() => {
    if (indexResetPending || indexPageState.page !== indexPage.page) {
      setIndexPageState({ page: indexPage.page, resetKey });
    }
  }, [indexPage.page, indexPageState.page, indexResetPending, resetKey]);

  useEffect(() => {
    const previousCourseKey = previousSelectedCourseKey.current;
    previousSelectedCourseKey.current = selectedCourseKey;
    if (!previousCourseKey || selectedCourseKey) return;

    const selectedIndex = courses.findIndex(
      (section) => courseCatalogKey(section.course) === previousCourseKey,
    );
    if (selectedIndex >= 0) {
      setIndexPageState({
        page: Math.floor(selectedIndex / COLLECTION_PAGE_SIZE.cards) + 1,
        resetKey,
      });
      setReturnFocusKey(previousCourseKey);
    } else {
      setReturnFocusKey(null);
    }
  }, [courses, resetKey, selectedCourseKey]);

  if (selectedCourseKey) {
    if (!selectedSection) {
      return <CourseUnavailable onShowAllCourses={onShowAllCourses} />;
    }
    return (
      <CourseDetail
        section={selectedSection}
        onShowAllCourses={onShowAllCourses}
        onClearFilters={onClearFilters}
        tools={detailTools}
        renderScenario={renderScenario}
        resetKey={
          selectedCourseKey +
          "|" +
          String(resetKey === undefined ? "" : resetKey)
        }
      />
    );
  }

  return (
    <>
      <CourseIndex
        courses={indexPage.items}
        focusCourseKey={returnFocusKey}
        onFocusRestored={() => setReturnFocusKey(undefined)}
        onSelectCourse={onSelectCourse}
      />
      <CollectionPagination
        page={indexPage.page}
        pageSize={indexPage.pageSize}
        totalItems={indexPage.totalItems}
        itemLabel="courses"
        onPageChange={(page) => setIndexPageState({ page, resetKey })}
      />
    </>
  );
}

function CourseIndex({
  courses,
  focusCourseKey,
  onFocusRestored,
  onSelectCourse,
}: {
  courses: readonly CourseCatalogSectionView[];
  focusCourseKey: string | null | undefined;
  onFocusRestored: () => void;
  onSelectCourse: (courseKey: string) => void;
}) {
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusCourseKey === undefined) return;
    const control = focusCourseKey
      ? controls.current.get(focusCourseKey)
      : undefined;
    (control ?? list.current)?.focus();
    onFocusRestored();
  }, [courses, focusCourseKey, onFocusRestored]);

  return (
    <div ref={list} tabIndex={-1} className="outline-none">
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {courses.map((section) => {
          const key = courseCatalogKey(section.course);
          const headingId = courseHeadingId(section.course) + "-index";
          const summaryId = headingId + "-summary";
          const scenarioCount = section.accessibleScenarios.length;
          const progressPercent = scenarioCount
            ? Math.round((section.solvedCount / scenarioCount) * 100)
            : 0;
          const matchingCount = section.visibleScenarios.length;
          const actionLabel = courseActionLabel(section);

          return (
            <li
              key={key}
              className="@container/course"
              data-course-id={section.course.courseId ?? "general-practice"}
              data-course-scope={courseScope(section)}
              data-course-view="index"
            >
              <button
                ref={(node) => {
                  if (node) controls.current.set(key, node);
                  else controls.current.delete(key);
                }}
                type="button"
                aria-labelledby={headingId}
                aria-describedby={summaryId}
                onClick={() => onSelectCourse(key)}
                className="group grid w-full min-w-0 cursor-pointer gap-4 px-4 py-4 text-left transition-colors hover:bg-brand-subtle/45 focus-visible:bg-brand-subtle/45 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/35 sm:px-5 sm:py-5 @3xl/course:grid-cols-[minmax(0,1fr)_23rem] @3xl/course:items-center"
              >
                <span id={summaryId} className="sr-only">
                  <CourseDescription links={false}>
                    {section.course.description}
                  </CourseDescription>{" "}
                  {scenarioCount}{" "}
                  {scenarioCount === 1 ? "scenario" : "scenarios"}, about{" "}
                  {section.totalEstimatedMinutes} minutes total,{" "}
                  {section.solvedCount} of {scenarioCount} solved.
                </span>
                <span className="min-w-0 space-y-2">
                  <span className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-label">
                      {courseEyebrow(section)}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-text @3xl/course:hidden">
                      {actionLabel}
                      <ArrowRight className="size-4" aria-hidden />
                    </span>
                  </span>
                  <span
                    id={headingId}
                    role="heading"
                    aria-level={2}
                    className="block text-page-title text-balance [overflow-wrap:anywhere] transition-colors group-hover:text-brand-text"
                  >
                    {section.course.title}
                  </span>
                  <span className="block max-w-3xl text-body text-muted-foreground text-pretty">
                    <CourseDescription links={false}>
                      {section.course.description}
                    </CourseDescription>
                  </span>
                  <span className="block pt-2">
                    <span className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-sm tabular-nums">
                      <span className="font-medium text-foreground">
                        {section.solvedCount} of {scenarioCount} solved
                      </span>
                      {matchingCount < scenarioCount ? (
                        <span className="text-muted-foreground">
                          {matchingCount} matching{" "}
                          {matchingCount === 1 ? "scenario" : "scenarios"}
                        </span>
                      ) : null}
                    </span>
                    <span
                      role="progressbar"
                      aria-label={section.course.title + " solved progress"}
                      aria-valuemin={0}
                      aria-valuemax={scenarioCount}
                      aria-valuenow={section.solvedCount}
                      className="mt-2 block h-1 overflow-hidden bg-border/70"
                    >
                      <span
                        className="block h-full bg-brand-text"
                        style={{ width: progressPercent + "%" }}
                      />
                    </span>
                  </span>
                </span>

                <span
                  data-course-facts
                  className="flex w-full flex-wrap items-center justify-between gap-5 border-t pt-4 @3xl/course:grid @3xl/course:grid-cols-[minmax(0,1fr)_auto] @3xl/course:border-t-0 @3xl/course:pt-0"
                >
                  <span
                    data-course-metrics
                    className="flex min-w-0 flex-wrap gap-x-5 gap-y-2 text-sm tabular-nums text-foreground"
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <BookOpenCheck
                        className="size-4 text-brand-text"
                        aria-hidden
                      />
                      {scenarioCount}{" "}
                      {scenarioCount === 1 ? "scenario" : "scenarios"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Clock3 className="size-4 text-brand-text" aria-hidden />~
                      {section.totalEstimatedMinutes} min total
                    </span>
                  </span>
                  <span
                    data-course-action
                    className="hidden items-center gap-2 whitespace-nowrap text-sm font-semibold text-brand-text @3xl/course:inline-flex"
                  >
                    {actionLabel}
                    <ArrowRight
                      className="size-4 transition-transform group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CourseDetail({
  section,
  onShowAllCourses,
  onClearFilters,
  tools,
  renderScenario,
  resetKey,
}: {
  section: CourseCatalogSectionView;
  onShowAllCourses: () => void;
  onClearFilters?: (() => void) | undefined;
  tools?: ReactNode;
  renderScenario: (
    scenario: ScenarioCatalogWireEntry,
    context: CourseScenarioRendererContext,
  ) => ReactNode;
  resetKey: string;
}) {
  const headingId = courseHeadingId(section.course);
  const heading = useRef<HTMLHeadingElement>(null);
  const scenarioCount = section.accessibleScenarios.length;
  const courseKey = courseCatalogKey(section.course);
  const curriculumState = getCourseCurriculumState(section.accessibleScenarios);
  const nextVisibleIndex = curriculumState.nextScenarioId
    ? section.visibleScenarios.findIndex(
        (scenario) => scenario.scenarioId === curriculumState.nextScenarioId,
      )
    : -1;
  const initialCurriculumPage =
    nextVisibleIndex >= 0
      ? Math.floor(nextVisibleIndex / COLLECTION_PAGE_SIZE.cards) + 1
      : 1;
  const sequenceByScenarioId =
    section.course.kind === "authored"
      ? new Map(
          section.accessibleScenarios.map((scenario, index) => [
            scenario.scenarioId,
            index + 1,
          ]),
        )
      : undefined;

  useEffect(() => {
    heading.current?.focus();
  }, [section.course]);

  return (
    <section
      className="space-y-4 sm:space-y-5"
      aria-labelledby={headingId}
      data-course-id={section.course.courseId ?? "general-practice"}
      data-course-scope={courseScope(section)}
      data-course-view="detail"
    >
      <header className="border-b pb-5">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="-ml-1 h-9 px-1 sm:hidden"
          onClick={onShowAllCourses}
        >
          <ArrowLeft className="size-4" aria-hidden />
          All courses
        </Button>
        <div className="mt-2 min-w-0 space-y-2">
          <h2
            ref={heading}
            id={headingId}
            tabIndex={-1}
            className="text-page-title text-balance outline-none [overflow-wrap:anywhere] sm:text-feature-title"
          >
            {section.course.title}
          </h2>
          <p className="max-w-3xl text-body text-muted-foreground text-pretty">
            <CourseDescription>{section.course.description}</CourseDescription>
          </p>
          <dl className="flex flex-wrap gap-x-2 gap-y-1 pt-1 text-sm text-muted-foreground tabular-nums">
            <CourseFact
              label="Scenarios"
              value={`${scenarioCount} ${scenarioCount === 1 ? "scenario" : "scenarios"}`}
            />
            <CourseFact
              label="Estimated time"
              value={`~${section.totalEstimatedMinutes} min total`}
            />
            <CourseFact
              label="Solved progress"
              value={`${section.solvedCount} of ${scenarioCount} solved`}
            />
          </dl>
        </div>
      </header>

      {tools}

      {section.visibleScenarios.length ? (
        <PaginatedCollection
          items={section.visibleScenarios}
          pageSize={COLLECTION_PAGE_SIZE.cards}
          itemLabel="scenarios"
          initialPage={initialCurriculumPage}
          resetKey={`${resetKey}|next:${curriculumState.nextScenarioId ?? ""}`}
        >
          {(visibleScenarios) => (
            <ol
              className="divide-y overflow-hidden rounded-xl border bg-card"
              aria-label={section.course.title + " course steps"}
            >
              {visibleScenarios.map((scenario) => {
                const position = sequenceByScenarioId?.get(scenario.scenarioId);
                const context: CourseScenarioRendererContext = {
                  courseKey,
                  courseTitle: section.course.title,
                  course: section.course,
                  ...(position
                    ? {
                        sequence: {
                          position,
                          total: scenarioCount,
                        },
                      }
                    : {}),
                  isNext:
                    curriculumState.nextScenarioId === scenario.scenarioId,
                };

                return (
                  <li key={scenario.scenarioId}>
                    {renderScenario(scenario, context)}
                  </li>
                );
              })}
            </ol>
          )}
        </PaginatedCollection>
      ) : (
        <div className="flex min-h-44 flex-col items-start justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-6">
          <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
            <Search className="size-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-section-title">
              No scenarios match your filters
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Clear the filters to see every scenario in this course.
            </p>
          </div>
          {onClearFilters ? (
            <Button variant="outline" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function CourseUnavailable({
  onShowAllCourses,
}: {
  onShowAllCourses: () => void;
}) {
  return (
    <div
      role="status"
      className="flex min-h-48 flex-col items-start justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-6"
    >
      <div>
        <h2 className="text-page-title">Course not available</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          It may have been unpublished or may not be available in this catalog.
        </p>
      </div>
      <Button variant="outline" onClick={onShowAllCourses}>
        <ArrowLeft className="size-4" aria-hidden />
        All courses
      </Button>
    </div>
  );
}

function courseEyebrow(section: CourseCatalogSectionView) {
  return section.course.kind === "general-practice"
    ? "Open practice"
    : section.course.organizationId
      ? "Organization course"
      : "Course";
}

function courseScope(section: CourseCatalogSectionView) {
  return section.course.kind === "general-practice"
    ? "generated"
    : (section.course.organizationId ?? "public");
}

function courseActionLabel(section: CourseCatalogSectionView) {
  const scenarios = section.accessibleScenarios;

  if (
    scenarios.length > 0 &&
    scenarios.every((scenario) => scenario.progress.status === "completed")
  ) {
    return "Review course";
  }
  if (scenarios.some((scenario) => scenario.progress.status !== "new")) {
    return "Open course";
  }
  return "View scenarios";
}

function CourseFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 after:text-border after:content-['·'] last:after:hidden">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
