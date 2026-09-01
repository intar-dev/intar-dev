import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Gauge,
  LockKeyhole,
  Users,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import {
  MetaDifficulty,
  MetaLine,
  SCENARIO_DIFFICULTIES,
} from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState, EmptyState } from "@/components/app/patterns/StateCard";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
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
import { cn } from "@/lib/utils";
import { CourseLink, LectureLink } from "./course-links";
import {
  compactCatalogSearch,
  normalizeCatalogSearch,
  type NormalizedCatalogSearch,
} from "./catalog-search";
import {
  courseCatalogQueryKey,
  courseRouteForCatalogCourse,
  fetchCourseCatalog,
  lectureStatePresentation,
  type CourseCatalogCourse,
  type CourseLectureBlocker,
  type CourseLectureSummary,
  type CourseRouteRef,
  type CourseRouteScope,
} from "./course-wire";

interface MyAssignmentsResponse {
  assignments: Array<{
    assignmentId: string;
    organizationId: string;
    organizationName: string;
    scenarioTitle: string | null;
    assignedAt: number;
    lecture: {
      courseId: string;
      lectureId: string;
      title: string;
      state: CourseLectureSummary["state"];
      blockedBy: CourseLectureBlocker | null;
      scope: CourseRouteScope;
    } | null;
  }>;
}

export function PublicCourseCatalog() {
  return <CourseCatalogPage organizationId={null} courseId={null} />;
}

export function PublicCourseDetail() {
  const { courseId } = useParams({ from: "/app/courses/$courseId" });
  return <CourseCatalogPage organizationId={null} courseId={courseId} />;
}

export function OrganizationCourseCatalog() {
  const { orgId } = useParams({ from: "/app/organizations/$orgId/courses" });
  return <CourseCatalogPage organizationId={orgId} courseId={null} />;
}

export function OrganizationPublicCourseCatalog() {
  const { orgId, courseId } = useParams({
    from: "/app/organizations/$orgId/courses/public/$courseId",
  });
  return (
    <CourseCatalogPage
      organizationId={orgId}
      courseId={courseId}
      requestedScope="organization-public"
    />
  );
}

export function OrganizationPrivateCourseCatalog() {
  const { orgId, courseId } = useParams({
    from: "/app/organizations/$orgId/courses/private/$courseId",
  });
  return (
    <CourseCatalogPage
      organizationId={orgId}
      courseId={courseId}
      requestedScope="organization-private"
    />
  );
}

function CourseCatalogPage({
  organizationId,
  courseId,
  requestedScope,
}: {
  organizationId: string | null;
  courseId: string | null;
  requestedScope?: CourseRouteScope;
}) {
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false });
  const searchState = useMemo(
    () => normalizeCatalogSearch(routeSearch),
    [routeSearch],
  );
  const [searchText, setSearchText] = useState(searchState.q);
  const catalog = useQuery({
    queryKey: courseCatalogQueryKey(organizationId),
    queryFn: () => fetchCourseCatalog(organizationId),
    staleTime: 10_000,
  });
  const assignments = useQuery({
    queryKey: ["organizations", "my-assignments"],
    enabled: organizationId === null,
    queryFn: async () => {
      const response = await fetch("/api/organizations/my-assignments", {
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as
        | MyAssignmentsResponse
        | { error?: string }
        | null;
      if (!response.ok || !body || !("assignments" in body)) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : "Could not load assignments.",
        );
      }
      return body;
    },
    staleTime: 30_000,
  });
  const courses = catalog.data?.courses ?? [];
  const visibleCourses = useMemo(
    () => filterCourses(courses, searchState),
    [courses, searchState],
  );
  const course = useMemo(
    () =>
      courseId
        ? courses.find(
            (candidate) =>
              candidate.courseId === courseId &&
              courseMatchesScope(candidate, organizationId, requestedScope),
          ) ?? null
        : null,
    [courseId, courses, organizationId, requestedScope],
  );
  const visibleLectures = useMemo(
    () => (course ? filterLectures(course, searchState) : []),
    [course, searchState],
  );
  const allCategories = useMemo(
    () =>
      [...new Set(courses.flatMap((item) => item.lectures.map((lecture) => lecture.category)))]
        .filter(Boolean)
        .sort(),
    [courses],
  );
  const allTags = useMemo(
    () => [...new Set(courses.flatMap((item) => item.lectures.flatMap((lecture) => lecture.tags)))].sort(),
    [courses],
  );
  const filtersActive = Boolean(
    searchState.q ||
      searchState.difficulty ||
      searchState.category ||
      searchState.tags.length,
  );
  useEffect(() => {
    setSearchText((current) => (current === searchState.q ? current : searchState.q));
  }, [searchState.q]);
  useEffect(() => {
    const query = searchText.trim();
    if (query === searchState.q) return;
    const timeout = window.setTimeout(() => {
      void navigate({
        to: ".",
        replace: true,
        search: compactCatalogSearch({ ...searchState, q: query }),
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [navigate, searchState, searchText]);
  usePageChrome({ title: course?.title ?? (courseId ? "Course" : "Courses") });

  const setFilter = (next: NormalizedCatalogSearch) =>
    void navigate({ to: ".", replace: true, search: compactCatalogSearch(next) });
  const toggleTag = (tag: string) =>
    setFilter({
      ...searchState,
      tags: searchState.tags.includes(tag)
        ? searchState.tags.filter((entry) => entry !== tag)
        : [...searchState.tags, tag].sort(),
    });
  const clearFilters = () => {
    setSearchText("");
    setFilter({
      q: "",
      difficulty: undefined,
      category: undefined,
      tags: [],
    });
  };
  const filters = courses.length ? (
    <CourseFilters
      search={searchText}
      onSearchChange={setSearchText}
      searchState={searchState}
      categories={allCategories}
      tags={allTags}
      filtersActive={filtersActive}
      onFilter={setFilter}
      onToggleTag={toggleTag}
      onClear={clearFilters}
    />
  ) : null;

  if (catalog.isLoading && !catalog.data) {
    return <CourseCatalogLoading />;
  }
  if (catalog.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load courses"
          description={
            catalog.error instanceof Error
              ? catalog.error.message
              : "Try again to load the course catalog."
          }
          onRetry={() => void catalog.refetch()}
        />
      </PageShell>
    );
  }
  if (courseId && !course) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Course not available"
          description="This course is not available in the current catalog."
        />
      </PageShell>
    );
  }
  if (course) {
    return (
      <CourseDetail
        course={course}
        lectures={visibleLectures}
        organizationId={organizationId}
        filters={filters}
        filtersActive={filtersActive}
        onClearFilters={clearFilters}
        capacityPressure={catalog.data?.capacityPressure ?? null}
      />
    );
  }
  return (
    <CourseIndex
      courses={visibleCourses}
      organizationId={organizationId}
      filters={filters}
      filtersActive={filtersActive}
      onClearFilters={clearFilters}
      capacityPressure={catalog.data?.capacityPressure ?? null}
      assignments={assignments.data?.assignments ?? []}
      search={compactCatalogSearch({
        ...searchState,
        q: searchText.trim(),
      })}
    />
  );
}

function CourseIndex({
  courses,
  organizationId,
  filters,
  filtersActive,
  onClearFilters,
  capacityPressure,
  assignments,
  search,
}: {
  courses: readonly CourseCatalogCourse[];
  organizationId: string | null;
  filters: ReactNode;
  filtersActive: boolean;
  onClearFilters: () => void;
  capacityPressure: number | null;
  assignments: MyAssignmentsResponse["assignments"];
  search: ReturnType<typeof compactCatalogSearch>;
}) {
  return (
    <PageShell width="content">
      <ContentHeader
        title="Courses"
        summary="Learn the idea first, then apply it in a scenario."
      />
      {capacityPressure !== null ? <CourseCapacityPressure pressure={capacityPressure} /> : null}
      {assignments.length ? <CourseAssignments assignments={assignments} /> : null}
      {filters}
      {courses.length ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {courses.map((course) => (
            <li key={`${course.organizationId ?? "public"}:${course.courseId}`}>
              <CourseIndexItem
                course={course}
                organizationId={organizationId}
                search={search}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title={filtersActive ? "No courses match your filters" : "No courses are available"}
          description={
            filtersActive
              ? "Try a different search term or clear the filters."
              : "A published course will appear here when it is ready."
          }
          action={
            filtersActive ? (
              <Button variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
    </PageShell>
  );
}

function CourseIndexItem({
  course,
  organizationId,
  search,
}: {
  course: CourseCatalogCourse;
  organizationId: string | null;
  search: ReturnType<typeof compactCatalogSearch>;
}) {
  const route = courseRouteForCatalogCourse(course, organizationId);
  const completed = course.lectures.filter(
    (lecture) => lecture.state === "completed",
  ).length;
  const totalMinutes = course.lectures.reduce(
    (total, lecture) => total + (lecture.estimatedMinutes ?? 0),
    0,
  );
  const courseScope = course.organizationId ? "private" : "public";

  return (
    <CourseLink
      route={route}
      search={search}
      className="group grid min-h-28 gap-4 px-4 py-5 outline-none transition-colors hover:bg-brand-subtle/45 focus-visible:bg-brand-subtle/45 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:px-6"
    >
      <span className="min-w-0 space-y-2">
        <span className="block text-page-title text-balance [overflow-wrap:anywhere] transition-colors group-hover:text-brand-text">
          {course.title}
        </span>
        <span className="prose-measure block text-body text-muted-foreground text-pretty">
          {course.summary}
        </span>
        <span className="block pt-1">
          <MetaLine
            items={[
              organizationId ? `${courseScope} course` : null,
              `${completed} of ${course.lectures.length} complete`,
              `${course.lectures.length} ${course.lectures.length === 1 ? "lecture" : "lectures"}`,
              totalMinutes ? `~${totalMinutes} min` : null,
            ]}
          />
        </span>
      </span>
      <span className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-text sm:justify-self-end">
        {course.lectures.length > 0 && completed === course.lectures.length
          ? "Review course"
          : "Open course"}
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          aria-hidden
        />
      </span>
    </CourseLink>
  );
}

function CourseDetail({
  course,
  lectures,
  organizationId,
  filters,
  filtersActive,
  onClearFilters,
  capacityPressure,
}: {
  course: CourseCatalogCourse;
  lectures: readonly CourseLectureSummary[];
  organizationId: string | null;
  filters: ReactNode;
  filtersActive: boolean;
  onClearFilters: () => void;
  capacityPressure: number | null;
}) {
  const route = courseRouteForCatalogCourse(course, organizationId);
  const complete = course.lectures.filter(
    (lecture) => lecture.state === "completed",
  ).length;

  return (
    <PageShell width="content">
      <div className="space-y-4">
        <CourseIndexBackLink organizationId={organizationId} />
        <ContentHeader
          title={course.title}
          summary={course.summary}
          meta={
            <MetaLine
              items={[
                `${complete} of ${course.lectures.length} complete`,
                course.sequential ? "Sequence required" : "Any order",
              ]}
            />
          }
        />
      </div>
      {capacityPressure !== null ? <CourseCapacityPressure pressure={capacityPressure} /> : null}
      {course.bodyMarkdown.trim() ? (
        <section className="prose-measure border-y py-6 text-body leading-7">
          <Markdown pageContent>{course.bodyMarkdown}</Markdown>
        </section>
      ) : null}
      <section aria-labelledby="course-lectures-heading" className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="course-lectures-heading" className="text-section-title">
            Course lectures
          </h2>
          <span className="text-metadata tabular-nums">
            {course.lectures.length} total
          </span>
        </div>
        {filters}
        {lectures.length ? (
          <ol className="divide-y overflow-hidden rounded-xl border bg-card">
            {lectures.map((lecture) => {
              const position = course.lectures.findIndex(
                (candidate) => candidate.lectureId === lecture.lectureId,
              );
              return (
                <li key={lecture.lectureId}>
                  <LectureListItem
                    lecture={lecture}
                    route={route}
                    position={position + 1}
                    total={course.lectures.length}
                  />
                </li>
              );
            })}
          </ol>
        ) : (
          <EmptyState
            title="No lectures match your filters"
            description="Clear the filters to see the full course sequence."
            action={
              filtersActive ? (
                <Button variant="outline" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}
      </section>
    </PageShell>
  );
}

function CourseIndexBackLink({ organizationId }: { organizationId: string | null }) {
  return organizationId ? (
    <Link
      to="/organizations/$orgId/courses"
      params={{ orgId: organizationId }}
      className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All organization courses
    </Link>
  ) : (
    <Link
      to="/courses"
      className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All courses
    </Link>
  );
}

function LectureListItem({
  lecture,
  route,
  position,
  total,
}: {
  lecture: CourseLectureSummary;
  route: ReturnType<typeof courseRouteForCatalogCourse>;
  position: number;
  total: number;
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary font-mono text-sm font-semibold tabular-nums text-secondary-foreground",
          lecture.state === "completed" && "bg-success text-success-foreground",
          lecture.state === "in_progress" && "bg-brand-text text-primary-foreground",
        )}
      >
        {lecture.state === "completed" ? (
          <Check className="size-4" aria-label="Complete" />
        ) : (
          position
        )}
      </span>
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-card-title [overflow-wrap:anywhere] transition-colors group-hover:text-brand-text">
            {lecture.title}
          </span>
          <LectureStatus lecture={lecture} />
        </span>
        <span className="block text-support text-muted-foreground text-pretty">
          {lecture.summary}
        </span>
        <MetaLine
          className="text-xs"
          items={[
            `Lecture ${position} of ${total}`,
            lecture.category || null,
            lecture.difficulty ? (
              <MetaDifficulty key="difficulty" difficulty={lecture.difficulty} />
            ) : null,
            lecture.estimatedMinutes ? `~${lecture.estimatedMinutes} min` : null,
            lecture.scenarioId ? "Scenario" : "Theory",
          ]}
        />
        {lecture.state === "locked" && lecture.blockedBy ? (
          <span className="block text-caption text-muted-foreground">
            Complete{" "}
            <LectureLink
              route={{ ...route, courseId: lecture.blockedBy.courseId }}
              lectureId={lecture.blockedBy.lectureId}
              className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              “{lecture.blockedBy.title}”
            </LectureLink>{" "}
            first.
          </span>
        ) : null}
      </span>
      <span className="flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-text">
        {lectureActionLabel(lecture)}
        {lecture.state === "locked" ? (
          <LockKeyhole className="size-4" aria-hidden />
        ) : (
          <ArrowRight
            className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
            aria-hidden
          />
        )}
      </span>
    </>
  );

  const className = cn(
    "group flex min-h-20 items-start gap-3 px-4 py-4 outline-none sm:items-center sm:gap-4 sm:px-6",
    lecture.state === "locked"
      ? "bg-muted/35 text-muted-foreground"
      : "transition-colors hover:bg-brand-subtle/45 focus-visible:bg-brand-subtle/45 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/40",
  );
  return lecture.state === "locked" ? (
    <div className={className} data-lecture-state="locked">
      {content}
    </div>
  ) : (
    <LectureLink
      route={route}
      lectureId={lecture.lectureId}
      className={className}
    >
      {content}
    </LectureLink>
  );
}

function LectureStatus({ lecture }: { lecture: CourseLectureSummary }) {
  const { tone, word } = lectureStatePresentation(lecture.state);
  return <StatusToken tone={tone} word={word} pulse={lecture.state === "in_progress"} />;
}

function lectureActionLabel(lecture: CourseLectureSummary) {
  switch (lecture.state) {
    case "locked":
      return "Locked";
    case "available":
      return "Read";
    case "waiting_for_scenario":
      return "Read";
    case "in_progress":
      return "Resume";
    case "completed":
      return "Review";
  }
}

function courseMatchesScope(
  course: CourseCatalogCourse,
  organizationId: string | null,
  requestedScope: CourseRouteScope | undefined,
) {
  if (!organizationId) return course.organizationId === null;
  if (requestedScope === "organization-private") {
    return course.organizationId === organizationId;
  }
  return course.organizationId === null;
}

function CourseCapacityPressure({ pressure }: { pressure: number }) {
  const summary = pressure === 100 ? "100% pool use · At capacity" : `${pressure}% pool use`;
  return (
    <div
      aria-label="Scenario capacity"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <Gauge className="size-3.5" aria-hidden />
        Scenario capacity
      </span>
      <span role="status" aria-atomic="true" className="tabular-nums">
        {summary}
      </span>
      <span
        role="progressbar"
        aria-label="Scenario capacity used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pressure}
        className="block h-1 w-24 bg-border/70 sm:w-32"
      >
        <span
          className={cn("block h-full", pressure === 100 ? "bg-destructive" : "bg-muted-foreground")}
          style={{ width: `${pressure}%` }}
        />
      </span>
      <span className="sr-only">
        This is the highest use across pooled CPU, memory, and disk.
      </span>
    </div>
  );
}

function CourseAssignments({
  assignments,
}: {
  assignments: MyAssignmentsResponse["assignments"];
}) {
  return (
    <section aria-labelledby="course-assignments-heading" className="space-y-4">
      <h2 id="course-assignments-heading" className="text-section-title">
        Assignments
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {assignments.map((assignment) => (
          <li key={assignment.assignmentId}>
            <AssignmentLink assignment={assignment} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssignmentLink({
  assignment,
}: {
  assignment: MyAssignmentsResponse["assignments"][number];
}) {
  const lecture = assignment.lecture;
  const target = lecture?.state === "locked" ? lecture.blockedBy : lecture;
  const route: CourseRouteRef | null =
    lecture && target
      ? {
          scope: lecture.scope,
          courseId: target.courseId,
          organizationId: assignment.organizationId,
        }
      : null;
  const locked = lecture?.state === "locked";
  const content = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
        <Users className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block text-sm font-semibold [overflow-wrap:anywhere]">
          {locked ? target?.title : lecture?.title ?? assignment.scenarioTitle ?? "Assigned lecture"}
        </span>
        <span className="block text-caption">
          {locked && lecture?.blockedBy
            ? `Complete “${lecture.blockedBy.title}” first · assigned by ${assignment.organizationName}`
            : `Assigned by ${assignment.organizationName}`}
        </span>
      </span>
      <span className="col-start-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-text sm:col-start-auto">
        {locked ? "Open requirement" : "Open lecture"}
        <ArrowRight className="size-4" aria-hidden />
      </span>
    </>
  );
  const className = "group grid min-h-16 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-4 py-4 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/40 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-6";

  return route && target ? (
    <LectureLink route={route} lectureId={target.lectureId} className={className}>
      {content}
    </LectureLink>
  ) : (
    <Link
      to="/organizations/$orgId/courses"
      params={{ orgId: assignment.organizationId }}
      className={className}
    >
      {content}
    </Link>
  );
}

function CourseFilters({
  search,
  onSearchChange,
  searchState,
  categories,
  tags,
  filtersActive,
  onFilter,
  onToggleTag,
  onClear,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchState: NormalizedCatalogSearch;
  categories: readonly string[];
  tags: readonly string[];
  filtersActive: boolean;
  onFilter: (next: NormalizedCatalogSearch) => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}) {
  return (
    <FilterBar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search courses and lectures…"
      searchLabel="Search courses and lectures"
      filtersActive={filtersActive}
      stackSearchOnMobile
      onClear={onClear}
    >
      <div className="flex flex-wrap items-center gap-2">
        {SCENARIO_DIFFICULTIES.map((difficulty) => (
          <FilterChip
            key={difficulty}
            active={searchState.difficulty === difficulty}
            onClick={() =>
              onFilter({
                ...searchState,
                difficulty:
                  searchState.difficulty === difficulty ? undefined : difficulty,
              })
            }
          >
            {difficulty}
          </FilterChip>
        ))}
      </div>
      {categories.length ? (
        <Select
          value={searchState.category ?? "all"}
          onValueChange={(value) =>
            onFilter({
              ...searchState,
              category: typeof value === "string" && value !== "all" ? value : undefined,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Filter lectures by category">
            Category: {searchState.category ?? "All"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category} value={category}>
                {category}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {tags.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="outline" size="sm" aria-label="Filter lectures by tags" />
              }
            >
              Tags{searchState.tags.length ? ` · ${searchState.tags.length}` : ""}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-72 min-w-48">
              {tags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={searchState.tags.includes(tag)}
                  onCheckedChange={() => onToggleTag(tag)}
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
              onClick={() => onToggleTag(tag)}
              className="normal-case"
            >
              {tag}
            </FilterChip>
          ))}
        </div>
      ) : null}
    </FilterBar>
  );
}

export function filterCourses(
  courses: readonly CourseCatalogCourse[],
  filters: NormalizedCatalogSearch,
): CourseCatalogCourse[] {
  return courses.filter(
    (course) =>
      courseMatchesText(course, filters.q) || filterLectures(course, filters).length > 0,
  );
}

export function filterLectures(
  course: CourseCatalogCourse,
  filters: NormalizedCatalogSearch,
): CourseLectureSummary[] {
  const courseTextMatch = courseMatchesText(course, filters.q);
  return course.lectures.filter((lecture) => {
    if (filters.difficulty && lecture.difficulty !== filters.difficulty) return false;
    if (filters.category && lecture.category !== filters.category) return false;
    if (filters.tags.length && !filters.tags.every((tag) => lecture.tags.includes(tag))) {
      return false;
    }
    return !filters.q || courseTextMatch || lectureMatchesText(lecture, filters.q);
  });
}

function courseMatchesText(course: CourseCatalogCourse, query: string): boolean {
  return !query || matchesText(query, [course.title, course.summary]);
}

function lectureMatchesText(lecture: CourseLectureSummary, query: string): boolean {
  return matchesText(query, [lecture.title, lecture.summary, lecture.category, ...lecture.tags]);
}

function matchesText(query: string, values: readonly string[]): boolean {
  const normalized = query.toLocaleLowerCase();
  return values.some((value) => value.toLocaleLowerCase().includes(normalized));
}

function CourseCatalogLoading() {
  return (
    <PageShell width="content">
      <div role="status" className="space-y-6">
        <span className="sr-only">Loading courses…</span>
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-5 w-96 max-w-full" />
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          <Skeleton className="h-28 w-full rounded-none" />
          <Skeleton className="h-28 w-full rounded-none" />
          <Skeleton className="h-28 w-full rounded-none" />
        </div>
      </div>
    </PageShell>
  );
}
