import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  ArrowRight,
  CircleDot,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
import { CourseCurriculumItem } from "@/components/app/patterns/ScenarioCard";
import { SCENARIO_DIFFICULTIES } from "@/components/app/patterns/MetaLine";
import { useMyRuns } from "@/components/app/hooks/useMyRuns";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import {
  HttpResponseError,
  isAccessResponseError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";
import {
  CATALOG_SORT_OPTIONS,
  compactCatalogSearch,
  normalizeCatalogSearch,
  type CatalogSort,
  type NormalizedCatalogSearch,
} from "./catalog-search";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  CourseLocation,
  ScenarioCatalogWireResponse,
} from "@/lib/scenario-runs";
import { findScenarioCourseLocation } from "@/lib/course-location";
import { CourseCatalogBrowser } from "./CourseCatalogSections";
import {
  buildCourseCatalogSection,
  buildCourseCatalogView,
  courseCatalogKey,
} from "./course-catalog";
import { CourseScenarioLink } from "./course-route-links";

interface MyAssignmentsResponse {
  assignments: Array<{
    assignmentId: string;
    scenarioId: string;
    scenarioTitle: string | null;
    organizationId: string;
    organizationName: string;
    assignedAt: number;
    courseLocation: CourseLocation | null;
  }>;
}

export function ScenarioCatalog() {
  return <PublicCourseCatalogPage courseId={null} />;
}

export function CourseCatalogDetail() {
  const { courseId } = useParams({ from: "/app/courses/$courseId" });
  return <PublicCourseCatalogPage courseId={courseId} />;
}

function PublicCourseCatalogPage({ courseId }: { courseId: string | null }) {
  const routeSearch = useSearch({ strict: false });
  const searchState = useMemo(
    () => normalizeCatalogSearch(routeSearch),
    [routeSearch],
  );
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState(searchState.q);
  const [courseFiltersOpen, setCourseFiltersOpen] = useState(false);
  const pendingSearchNavigation = useRef<number | null>(null);

  const courses = useQuery({
    queryKey: ["scenarios", "list"],
    queryFn: async () => {
      const response = await fetch("/api/scenarios", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new HttpResponseError(
          response.status,
          body?.error ?? `Failed to load courses (${response.status})`,
        );
      }

      return (await response.json()) as ScenarioCatalogWireResponse;
    },
    staleTime: 10_000,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    retry: retryHttpResponseError,
  });

  const myAssignments = useQuery({
    queryKey: ["organizations", "my-assignments"],
    queryFn: async () => {
      const response = await fetch("/api/organizations/my-assignments", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new HttpResponseError(
          response.status,
          body?.error ?? `Failed to load assignments (${response.status})`,
        );
      }
      return (await response.json()) as MyAssignmentsResponse;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    retry: retryHttpResponseError,
  });

  const myRuns = useMyRuns();
  const courseAccessError = isAccessResponseError(courses.error);
  const assignmentAccessError = isAccessResponseError(myAssignments.error);
  const runsAccessError = isAccessResponseError(myRuns.error);
  const activeRuns = runsAccessError
    ? []
    : (myRuns.data?.runs ?? []).filter((run) => run.active);
  const courseLoadFailed = Boolean(
    courses.error && (!courses.data || courseAccessError),
  );
  const supplementalLoadFailed =
    !courseLoadFailed &&
    Boolean(
      (courses.error && courses.data) || myAssignments.error || myRuns.error,
    );

  const allCourses = courseAccessError ? [] : (courses.data?.courses ?? []);
  const allEntries = allCourses.flatMap((course) => course.scenarios);
  const assignments = assignmentAccessError
    ? []
    : (myAssignments.data?.assignments ?? []);

  const allTags = useMemo(
    () => [...new Set(allEntries.flatMap((scenario) => scenario.tags))].sort(),
    [allEntries],
  );

  const allCategories = useMemo(
    () =>
      [
        ...new Set(
          allEntries
            .map((scenario) => scenario.category)
            .filter((value) => value.trim()),
        ),
      ].sort(),
    [allEntries],
  );

  useEffect(() => {
    setSearchText((current) =>
      current.trim() === searchState.q ? current : searchState.q,
    );
  }, [searchState.q]);

  useEffect(() => {
    setCourseFiltersOpen(false);
  }, [courseId]);

  useEffect(() => {
    const nextQuery = searchText.trim();
    if (nextQuery === searchState.q) return;
    const timeout = window.setTimeout(() => {
      if (pendingSearchNavigation.current === timeout) {
        pendingSearchNavigation.current = null;
      }
      void navigateCatalogSearch(navigate, {
        ...searchState,
        q: nextQuery,
      });
    }, 250);
    pendingSearchNavigation.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (pendingSearchNavigation.current === timeout) {
        pendingSearchNavigation.current = null;
      }
    };
  }, [navigate, searchState, searchText]);

  const catalogFilter = useMemo(
    () => ({
      q: searchState.q,
      difficulty: searchState.difficulty,
      category: searchState.category,
      tags: searchState.tags,
      sort: searchState.sort,
    }),
    [
      searchState.category,
      searchState.difficulty,
      searchState.q,
      searchState.sort,
      searchState.tags,
    ],
  );
  const catalogView = useMemo(
    () => buildCourseCatalogView(allCourses, catalogFilter),
    [allCourses, catalogFilter],
  );
  const selectedCourse = useMemo(
    () =>
      courseId
        ? allCourses.find(
            (course) =>
              (course.kind === "general-practice" &&
                courseId === "general-practice") ||
              (course.kind === "authored" &&
                course.organizationId === null &&
                course.courseId === courseId),
          )
        : undefined,
    [allCourses, courseId],
  );
  const selectedSection = useMemo(
    () =>
      selectedCourse
        ? buildCourseCatalogSection(selectedCourse, catalogFilter)
        : null,
    [catalogFilter, selectedCourse],
  );
  usePageChrome({ title: selectedCourse?.title });

  const toggleTag = (tag: string) => {
    const nextTags = searchState.tags.includes(tag)
      ? searchState.tags.filter((entry) => entry !== tag)
      : [...searchState.tags, tag].sort();
    void navigateCatalogSearch(navigate, { ...searchState, tags: nextTags });
  };

  const filtersActive = Boolean(
    searchState.q ||
    searchState.difficulty ||
    searchState.category ||
    searchState.tags.length,
  );

  const clearFilters = () => {
    setSearchText("");
    setCourseFiltersOpen(false);
    void navigateCatalogSearch(navigate, {
      q: "",
      difficulty: undefined,
      category: undefined,
      tags: [],
      sort: searchState.sort,
    });
  };

  const renderFilterControls = () => (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-metadata mr-1">Difficulty</span>
        {SCENARIO_DIFFICULTIES.map((level) => (
          <FilterChip
            key={level}
            active={searchState.difficulty === level}
            onClick={() =>
              void navigateCatalogSearch(navigate, {
                ...searchState,
                difficulty:
                  searchState.difficulty === level ? undefined : level,
              })
            }
          >
            {level}
          </FilterChip>
        ))}
      </div>
      {allCategories.length ? (
        <Select
          value={searchState.category ?? "all"}
          onValueChange={(value) =>
            void navigateCatalogSearch(navigate, {
              ...searchState,
              category:
                typeof value === "string" && value !== "all"
                  ? value
                  : undefined,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Filter by category">
            Category: {searchState.category ?? "All"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {allCategories.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {allTags.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Filter by tags"
                />
              }
            >
              Tags
              {searchState.tags.length ? ` · ${searchState.tags.length}` : ""}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-72 min-w-48">
              {allTags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={searchState.tags.includes(tag)}
                  onCheckedChange={() => toggleTag(tag)}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {searchState.tags.map((tag) => (
            <FilterChip
              key={tag}
              active
              onClick={() => toggleTag(tag)}
              className="normal-case"
            >
              {tag}
            </FilterChip>
          ))}
        </div>
      ) : null}
    </>
  );

  const showCourseFilters = Boolean(
    courseId &&
    selectedSection &&
    (filtersActive ||
      (selectedSection.course.kind === "general-practice" &&
        selectedSection.accessibleScenarios.length > 1) ||
      selectedSection.accessibleScenarios.length > COLLECTION_PAGE_SIZE.cards),
  );
  const showCatalogRefinement = Boolean(
    filtersActive ||
    allCourses.length > 5 ||
    allEntries.length > COLLECTION_PAGE_SIZE.cards,
  );
  const detailTools = showCourseFilters ? (
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2"
        aria-expanded={courseFiltersOpen}
        aria-controls={
          courseFiltersOpen ? "course-scenario-filters" : undefined
        }
        onClick={() => setCourseFiltersOpen((open) => !open)}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        Filter scenarios
        {filtersActive ? (
          <span className="text-brand-text">Filters active</span>
        ) : null}
      </Button>
      {courseFiltersOpen ? (
        <div id="course-scenario-filters" className="border-t pt-4">
          <FilterBar
            search={searchText}
            onSearchChange={setSearchText}
            searchPlaceholder="Search this course…"
            searchLabel="Search this course"
            filtersActive={filtersActive}
            stackSearchOnMobile
            onClear={clearFilters}
            end={
              <>
                <span
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="text-metadata tabular-nums"
                >
                  {selectedSection
                    ? `${selectedSection.visibleScenarios.length} of ${selectedSection.accessibleScenarios.length} scenarios`
                    : "Course unavailable"}
                </span>
                {selectedSection?.course.kind === "general-practice" &&
                selectedSection.visibleScenarios.length ? (
                  <SortSelect
                    value={searchState.sort}
                    onChange={(sort) =>
                      void navigateCatalogSearch(navigate, {
                        ...searchState,
                        sort,
                      })
                    }
                  />
                ) : null}
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              {renderFilterControls()}
            </div>
          </FilterBar>
        </div>
      ) : null}
    </div>
  ) : undefined;

  return (
    <PageShell width={courseId ? "content" : "default"} density="comfortable">
      {courseLoadFailed ? (
        <Alert variant="destructive">
          <RefreshCw aria-hidden="true" />
          <AlertTitle>Could not load courses</AlertTitle>
          <AlertDescription>
            {courses.error instanceof Error
              ? courses.error.message
              : "Failed to load courses"}{" "}
            Try again to restore the catalog.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void courses.refetch()}
              disabled={courses.isFetching}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {supplementalLoadFailed ? (
        <Alert>
          <RefreshCw aria-hidden="true" />
          <AlertTitle>Some course information is out of date</AlertTitle>
          <AlertDescription>
            You can keep browsing. Retry to refresh course updates, active work,
            and assignments.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (courses.error) void courses.refetch();
                if (myAssignments.error) void myAssignments.refetch();
                if (myRuns.error) void myRuns.refetch();
              }}
              disabled={
                courses.isFetching ||
                myAssignments.isFetching ||
                myRuns.isFetching
              }
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {!courseId && activeRuns.length ? (
        <section className="space-y-4" aria-labelledby="active-work-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-eyebrow">Continue</p>
              <h2 id="active-work-heading" className="mt-2 text-section-title">
                Active work
              </h2>
            </div>
            <Link
              to="/runs"
              className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-text underline-offset-4 hover:underline"
            >
              View all runs
            </Link>
          </div>
          <div className="divide-y rounded-xl border bg-card">
            {activeRuns.map((run) => (
              <Link
                key={run.runId}
                to="/runs/$runId"
                params={{ runId: run.runId }}
                className="group flex min-h-20 items-center gap-4 px-4 py-4 transition-colors hover:bg-brand-subtle sm:px-6"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-brand-text">
                  <CircleDot className="size-4 motion-safe:animate-pulse" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-card-title text-balance">
                    {run.title}
                  </span>
                  <span className="text-metadata">
                    Repair in progress · resume the live shell
                  </span>
                </span>
                <span className="hidden text-sm font-semibold text-brand-text sm:inline">
                  Resume
                </span>
                <ArrowRight className="size-4 text-brand-text transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {!courseId && assignments.length ? (
        <section className="space-y-4" aria-labelledby="assignments-heading">
          <div>
            <p className="text-eyebrow">From your organizations</p>
            <h2 id="assignments-heading" className="mt-2 text-section-title">
              Assignments
            </h2>
          </div>
          <PaginatedCollection
            items={assignments}
            pageSize={COLLECTION_PAGE_SIZE.list}
            itemLabel="assignments"
          >
            {(visibleAssignments) => (
              <div className="divide-y overflow-hidden rounded-xl border bg-card">
                {visibleAssignments.map((assignment) => (
                  <CourseScenarioLink
                    key={assignment.assignmentId}
                    location={assignment.courseLocation}
                    scenarioId={assignment.scenarioId}
                    fallbackOrganizationId={assignment.organizationId}
                    className="group flex min-h-16 items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/60 sm:px-6"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                      <Users className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-balance">
                        {assignment.scenarioTitle ?? assignment.scenarioId}
                      </span>
                      <span className="text-metadata">
                        Assigned by {assignment.organizationName}
                      </span>
                    </span>
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </CourseScenarioLink>
                ))}
              </div>
            )}
          </PaginatedCollection>
        </section>
      ) : null}

      {allEntries.length && !courseId ? (
        <section className="space-y-3" aria-label="Course catalog">
          <FilterBar
            search={searchText}
            onSearchChange={setSearchText}
            searchPlaceholder="Search courses and scenarios…"
            searchLabel="Search courses and scenarios"
            filtersActive={filtersActive}
            stackSearchOnMobile
            onClear={clearFilters}
            end={
              showCatalogRefinement ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={courseFiltersOpen}
                    aria-controls={
                      courseFiltersOpen ? "catalog-filters" : undefined
                    }
                    onClick={() => setCourseFiltersOpen((open) => !open)}
                  >
                    <SlidersHorizontal className="size-4" aria-hidden />
                    Filters
                    {filtersActive ? (
                      <span className="text-brand-text">Active</span>
                    ) : null}
                  </Button>
                  <span
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    className="text-metadata tabular-nums"
                  >
                    {catalogView.courses.length} of {allCourses.length} courses
                  </span>
                </>
              ) : undefined
            }
          />
          {showCatalogRefinement && courseFiltersOpen ? (
            <div id="catalog-filters" className="border-t pt-4">
              <div className="flex flex-wrap items-center gap-3">
                {renderFilterControls()}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {courseLoadFailed ? null : courses.isLoading && !courses.data ? (
        <div role="status" className="space-y-3">
          <span className="sr-only">Loading courses…</span>
          <div
            aria-hidden="true"
            className="flex flex-wrap items-center gap-3"
          >
            <Skeleton className="h-11 min-w-56 flex-1 sm:max-w-xs" />
            <Skeleton className="ml-auto h-9 w-24" />
          </div>
          <div
            aria-hidden="true"
            className="divide-y overflow-hidden rounded-xl border bg-card"
          >
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="space-y-3 px-4 py-5 sm:px-6 sm:py-6">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-56 max-w-full" />
                <Skeleton className="h-4 w-full max-w-xl" />
                <Skeleton className="h-1 w-full max-w-2xl" />
              </div>
            ))}
          </div>
        </div>
      ) : !allEntries.length ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="No courses are available yet"
          description="New courses will appear here when they are ready. You can still review earlier work in My runs."
          action={
            <Button variant="outline" render={<Link to="/runs" />}>
              Open My runs
            </Button>
          }
        />
      ) : !courseId && !catalogView.visibleScenarioCount ? (
        <EmptyState
          icon={<Search />}
          title="No courses match your filters"
          description="Try a different search term, or clear the filters to see everything."
          action={
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <CourseCatalogBrowser
          courses={catalogView.courses}
          selectedCourseKey={
            courseId
              ? selectedCourse
                ? courseCatalogKey(selectedCourse)
                : courseId
              : undefined
          }
          selectedSection={selectedSection}
          onSelectCourse={(course) => {
            if (pendingSearchNavigation.current !== null) {
              window.clearTimeout(pendingSearchNavigation.current);
              pendingSearchNavigation.current = null;
            }
            const selected = allCourses.find(
              (candidate) => courseCatalogKey(candidate) === course,
            );
            if (!selected) return;
            void navigate({
              to: "/courses/$courseId",
              params: {
                courseId:
                  selected.kind === "general-practice"
                    ? "general-practice"
                    : selected.courseId,
              },
              search: compactCatalogSearch({
                ...searchState,
                q: searchText.trim(),
              }),
            });
          }}
          onShowAllCourses={() =>
            void navigate({
              to: "/courses",
              search: compactCatalogSearch(searchState),
            })
          }
          onClearFilters={clearFilters}
          detailTools={detailTools}
          resetKey={`${searchState.q}|${searchState.difficulty ?? ""}|${searchState.category ?? ""}|${searchState.tags.join(",")}|${searchState.sort}`}
          renderScenario={(scenario, context) => (
            <CourseCurriculumItem
              scenario={scenario}
              headingLevel={3}
              search={compactCatalogSearch(searchState)}
              sequence={context.sequence}
              isNext={context.isNext}
              courseLocation={findScenarioCourseLocation(
                [context.course],
                scenario.scenarioId,
                null,
              )}
            />
          )}
        />
      )}
    </PageShell>
  );
}

function SortSelect({
  value,
  onChange,
}: {
  value: CatalogSort;
  onChange: (value: CatalogSort) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as CatalogSort)}
    >
      <SelectTrigger size="sm" aria-label="Sort General practice scenarios">
        General practice sort:{" "}
        {CATALOG_SORT_OPTIONS.find((option) => option.value === value)?.label}
      </SelectTrigger>
      <SelectContent align="end">
        {CATALOG_SORT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function navigateCatalogSearch(
  navigate: ReturnType<typeof useNavigate>,
  next: NormalizedCatalogSearch,
  replace = true,
) {
  return navigate({
    to: ".",
    replace,
    search: compactCatalogSearch(next),
  });
}
