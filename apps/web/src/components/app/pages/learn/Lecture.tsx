import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  LockKeyhole,
  RotateCcw,
  SquareTerminal,
} from "lucide-react";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { useJustReached } from "@/components/app/patterns/use-just-reached";
import { Markdown } from "@/components/app/Markdown";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { MetaDifficulty, MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  beginScenarioRunBootEvidence,
  clearPendingScenarioRunBootEvidence,
  markPendingScenarioRunBootStage,
} from "@/lib/scenario-run-performance";
import { formatMinutes, sentenceCase } from "@/components/app/lib/format";
import { loadReplayTerminalFont } from "@/lib/replay/config";
import { cn } from "@/lib/utils";
import { CourseLink, LectureLink } from "./course-links";
import { CourseOutlineMobile, CourseOutlineRail } from "./CourseOutline";
import { LectureScenarioLabel } from "./LectureScenarioLabel";
import {
  CourseLectureLockedError,
  completeCourseLecture,
  courseCatalogQueryKey,
  fetchCourseCatalog,
  fetchCourseLecture,
  invalidateCourseCatalogs,
  lectureStatePresentation,
  type CourseCatalogCourse,
  type CourseLectureDetail,
  type CourseRouteRef,
} from "./course-wire";

export function PublicLecture() {
  const { courseId, lectureId } = useParams({
    from: "/app/courses/$courseId/lectures/$lectureId",
  });
  return <LecturePage route={{ scope: "public", courseId, organizationId: null }} lectureId={lectureId} />;
}

export function OrganizationPublicLecture() {
  const { orgId, courseId, lectureId } = useParams({
    from: "/app/organizations/$orgId/courses/public/$courseId/lectures/$lectureId",
  });
  return (
    <LecturePage
      route={{
        scope: "organization-public",
        courseId,
        organizationId: orgId,
      }}
      lectureId={lectureId}
    />
  );
}

type OutlineState = "ready" | "pending" | "error" | "none";

// The outline's column is reserved from the first paint (a placeholder while
// the catalog loads, a retry if it fails), so the reading text never reflows.
function LectureLayout({
  children,
  course,
  outline,
  onRetryOutline,
  route,
  lectureId,
}: {
  children: ReactNode;
  course: CourseCatalogCourse | null;
  outline: OutlineState;
  onRetryOutline: () => void;
  route: CourseRouteRef;
  lectureId: string;
}) {
  return (
    <PageShell>
      <div
        className={cn(
          // The rail needs 58rem of page panel, which the sidebar's width
          // changes: a panel query, not a viewport one.
          "mx-auto grid w-full max-w-[128rem] min-w-0 gap-6 @min-[58rem]/panel:gap-8",
          outline !== "none" &&
            "@min-[58rem]/panel:grid-cols-[minmax(0,1fr)_minmax(15rem,18rem)] @min-[58rem]/panel:items-start",
        )}
      >
        <div className="min-w-0">{children}</div>
        {course ? (
          <CourseOutlineRail
            course={course}
            route={route}
            currentLectureId={lectureId}
          />
        ) : outline === "pending" ? (
          <aside
            aria-hidden="true"
            data-course-outline-placeholder
            className="hidden min-w-0 space-y-3 py-1 pl-2 @min-[58rem]/panel:block"
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-14 rounded-[0.625rem]" />
            <Skeleton className="h-14 rounded-[0.625rem]" />
            <Skeleton className="h-14 rounded-[0.625rem]" />
          </aside>
        ) : outline === "error" ? (
          <aside
            aria-label="Course outline"
            className="hidden min-w-0 space-y-2 py-1 pl-2 @min-[58rem]/panel:block"
          >
            <InlineFeedback tone="error">
              Could not load the course outline.
            </InlineFeedback>
            <Button variant="ghost" size="sm" onClick={onRetryOutline}>
              Try again
            </Button>
          </aside>
        ) : null}
      </div>
    </PageShell>
  );
}

export function OrganizationPrivateLecture() {
  const { orgId, courseId, lectureId } = useParams({
    from: "/app/organizations/$orgId/courses/private/$courseId/lectures/$lectureId",
  });
  return (
    <LecturePage
      route={{
        scope: "organization-private",
        courseId,
        organizationId: orgId,
      }}
      lectureId={lectureId}
    />
  );
}

// Design contract: theory comes first; the scenario action follows the reading.
function LecturePage({ route, lectureId }: { route: CourseRouteRef; lectureId: string }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["courses", "lecture", route.organizationId, route.courseId, lectureId],
    queryFn: () => fetchCourseLecture(route, lectureId),
    staleTime: 0,
    retry: (failureCount, error) =>
      !(error instanceof CourseLectureLockedError) && failureCount < 2,
  });
  const catalogQuery = useQuery({
    queryKey: courseCatalogQueryKey(route.organizationId),
    queryFn: () => fetchCourseCatalog(route.organizationId),
    staleTime: 30_000,
  });
  const lockedError =
    detailQuery.error instanceof CourseLectureLockedError
      ? detailQuery.error
      : null;
  // Never render a cached lecture body when the server now reports a lock.
  const detail = lockedError ? null : (detailQuery.data ?? null);

  const complete = useMutation({
    mutationFn: () => completeCourseLecture(route, lectureId),
    onSuccess: (next) => {
      queryClient.setQueryData(
        ["courses", "lecture", route.organizationId, route.courseId, lectureId],
        next,
      );
      invalidateCourseCatalogs(queryClient, route.organizationId);
    },
  });

  const breadcrumbLabels = useMemo(
    () => (detail ? lectureBreadcrumbLabels(route, detail.course.title) : undefined),
    [detail, route],
  );
  const outlineCourse = useMemo(
    () =>
      catalogQuery.data?.courses.find((course) => courseMatchesRoute(course, route)) ??
      null,
    [catalogQuery.data?.courses, route],
  );
  const outline: OutlineState = outlineCourse
    ? "ready"
    : catalogQuery.isPending
      ? "pending"
      : catalogQuery.isError
        ? "error"
        : "none";
  const outlineUtility = useMemo(
    () =>
      outlineCourse ? (
        <CourseOutlineMobile
          course={outlineCourse}
          route={route}
          currentLectureId={lectureId}
        />
      ) : undefined,
    [lectureId, outlineCourse, route],
  );
  // Once the lecture is on screen its title is the content's h1 and the bar
  // shows the course context; loading, locked and error states keep the bar h1.
  usePageChrome({
    title: detail?.lecture.title ?? "Lecture",
    breadcrumbLabels,
    utility: outlineUtility,
    reading: detail !== null,
  });

  if (lockedError) {
    const blocker = lockedError.blockedBy;
    return (
      <LectureLayout
        course={outlineCourse}
        outline={outline}
        onRetryOutline={() => void catalogQuery.refetch()}
        route={route}
        lectureId={lectureId}
      >
        <EmptyState
          icon={<LockKeyhole />}
          title="This lecture is locked"
          description={
            blocker
              ? `Complete “${blocker.title}” before you open this lecture.`
              : "Complete the required earlier lecture before you open this lecture."
          }
          action={
            blocker ? (
              <LectureLink
                route={{ ...route, courseId: blocker.courseId }}
                lectureId={blocker.lectureId}
                className={buttonVariants({ size: "lg" })}
              >
                Open required lecture
                <ArrowRight className="size-4" />
              </LectureLink>
            ) : undefined
          }
        />
      </LectureLayout>
    );
  }
  if (detailQuery.error && !detail) {
    return (
      <LectureLayout
        course={outlineCourse}
        outline={outline}
        onRetryOutline={() => void catalogQuery.refetch()}
        route={route}
        lectureId={lectureId}
      >
        <ErrorState
          title="Could not load this lecture"
          description={
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : "Try again to read this lecture."
          }
          onRetry={() => void detailQuery.refetch()}
        />
      </LectureLayout>
    );
  }
  if (!detail) {
    return (
      <LectureLayout
        course={outlineCourse}
        outline={outline}
        onRetryOutline={() => void catalogQuery.refetch()}
        route={route}
        lectureId={lectureId}
      >
        <LectureLoading />
      </LectureLayout>
    );
  }
  return (
    <LectureLayout
        course={outlineCourse}
        outline={outline}
        onRetryOutline={() => void catalogQuery.refetch()}
        route={route}
        lectureId={lectureId}
      >
      <div className="min-w-0 space-y-8">
        {detailQuery.error ? (
          <Alert role="status">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Lecture status may be out of date</AlertTitle>
            <AlertDescription>
              The last available theory is shown. Refresh before you start the scenario.
            </AlertDescription>
          </Alert>
        ) : null}
        <article aria-labelledby="lecture-title" className="min-w-0 space-y-8">
          <ContentHeader
            titleId="lecture-title"
            eyebrow={`${detail.course.title} · Lecture ${detail.lecture.lectureOrdinal} of ${detail.lecture.lectureCount}`}
            title={detail.lecture.title}
            reading
            summary={detail.lecture.summary}
            meta={<LectureMeta lecture={detail.lecture} />}
          />

          <Markdown pageContent>{detail.lecture.bodyMarkdown}</Markdown>
        </article>

        <LectureActionPanel
          lecture={detail.lecture}
          sequential={detail.course.sequential}
          route={route}
          completePending={complete.isPending}
          completeError={complete.error}
          onComplete={() => complete.mutate()}
        />
      </div>
    </LectureLayout>
  );
}

function LectureMeta({ lecture }: { lecture: CourseLectureDetail }) {
  const state = lectureStatePresentation(lecture.state);
  return (
    <MetaLine
      items={[
        <StatusToken key="status" tone={state.tone} word={state.word} />,
        lecture.category ? sentenceCase(lecture.category) : null,
        lecture.difficulty ? (
          <MetaDifficulty key="difficulty" difficulty={lecture.difficulty} />
        ) : null,
        lecture.estimatedMinutes
          ? `~${formatMinutes(lecture.estimatedMinutes)}`
          : null,
        <LectureScenarioLabel
          key="scenario"
          scenarioId={lecture.scenarioId}
        />,
      ]}
    />
  );
}

/** Pure copy for the reading gate's todo and done layers. */
export function lectureGateCopy({
  sequential,
  next,
}: {
  sequential: boolean;
  next: { title: string } | null;
}) {
  return {
    todoText: next
      ? sequential
        ? `This course opens one lecture at a time. Completing this one opens ${next.title}.`
        : `Next up is ${next.title}.`
      : "Completing this one finishes the course.",
    doneHeading: next ? "Lecture complete" : "Course complete",
    doneText: next
      ? `${next.title} is open.`
      : "You completed every lecture in this course.",
    announcement: next
      ? `Lecture complete. ${next.title} is open.`
      : "Lecture complete. You completed every lecture in this course.",
  };
}

function LectureActionPanel({
  lecture,
  sequential,
  route,
  completePending,
  completeError,
  onComplete,
}: {
  lecture: CourseLectureDetail;
  sequential: boolean;
  route: CourseRouteRef;
  completePending: boolean;
  completeError: unknown;
  onComplete: () => void;
}) {
  const isTheoryOnly = !lecture.scenarioId;
  const next = lecture.nextLecture;
  const courseComplete = lecture.state === "completed" && next === null;
  const done =
    lecture.state === "completed" && (isTheoryOnly || !lecture.activeRunId);
  // The Moment Rule: a gate that loads complete stays still; only a completion
  // that happens on this screen tints, draws its check and announces.
  const justDone =
    useJustReached(
      [[lecture.lectureId, done ? "done" : "todo"]] as const,
      "done",
    ).size > 0;
  const copy = lectureGateCopy({ sequential, next });
  const doneAction = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  // The button turns into a link when the lecture completes; carry focus over
  // if the reader activated the button.
  useEffect(() => {
    if (!justDone || !restoreFocus.current) return;
    restoreFocus.current = false;
    doneAction.current?.querySelector("a")?.focus();
  }, [justDone]);

  const continueLink = next ? (
    // The label carries the next title, so it wraps instead of stretching the page.
    <Button
      className="h-auto min-h-(--control-standard) w-full max-w-full py-2 text-left whitespace-normal [overflow-wrap:anywhere] sm:w-auto [@media(pointer:coarse)]:min-h-11"
      render={
        <LectureLink
          route={{ ...route, courseId: next.courseId }}
          lectureId={next.lectureId}
        >
          Continue to {next.title}
          <ArrowRight className="size-4" />
        </LectureLink>
      }
    />
  ) : null;
  const backToCourse = (
    <Button
      className="w-full [@media(pointer:coarse)]:min-h-11 sm:w-auto"
      render={<CourseLink route={route}>Back to course</CourseLink>}
    />
  );
  const completeButton = (
    <Button
      onClick={() => {
        if (completePending) return;
        restoreFocus.current = true;
        onComplete();
      }}
      aria-busy={completePending || undefined}
      className="w-full aria-busy:pointer-events-none aria-busy:opacity-100 sm:w-auto [@media(pointer:coarse)]:min-h-11"
    >
      <AsyncLabel
        state={completePending ? "pending" : "idle"}
        idle={
          <>
            Complete lecture
            <ArrowRight className="size-4" />
          </>
        }
        pending="Completing lecture…"
      />
    </Button>
  );
  const layer = (on: boolean) => (on ? { "data-on": "" } : {});

  return (
    <section
      aria-labelledby="lecture-next-action"
      data-done={done ? "" : undefined}
      className="flex w-full max-w-[46rem] flex-col gap-4 rounded-2xl border bg-card p-5 shadow-[var(--highlight),var(--shadow-raised)] sm:flex-row sm:items-start sm:gap-5"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-[0.625rem] inset-ring-1 transition-[background-color,color,box-shadow] duration-(--duration-reveal) ease-standard *:col-start-1 *:row-start-1",
          done
            ? "bg-success-subtle text-success inset-ring-success-border/60"
            : "bg-brand-subtle text-brand-text inset-ring-brand-border/60",
        )}
      >
        {isTheoryOnly ? (
          <BookOpen className={cn("size-5", done && "invisible")} />
        ) : (
          <SquareTerminal className={cn("size-5", done && "invisible")} />
        )}
        <Check
          className={cn(
            "size-5",
            !done && "invisible",
            done && justDone && "draw-check",
          )}
        />
      </span>
      <div className="min-w-0 flex-1 space-y-4">
      {isTheoryOnly ? (
        <div>
          <h2
            id="lecture-next-action"
            data-gate-swap
            className="text-section-title"
          >
            <span {...layer(!done)}>Mark this lecture complete</span>
            <span {...layer(done)}>{copy.doneHeading}</span>
          </h2>
          <p
            data-gate-swap
            className="mt-1.5 text-support text-muted-foreground"
          >
            <span {...layer(!done)}>{copy.todoText}</span>
            <span {...layer(done)}>{copy.doneText}</span>
          </p>
          <div
            data-gate-swap
            className="mt-4 grid-cols-[minmax(0,1fr)] justify-items-start"
          >
            <div {...layer(!done)}>{completeButton}</div>
            <div ref={doneAction} {...layer(done)}>
              {courseComplete ? backToCourse : continueLink}
            </div>
          </div>
        </div>
      ) : (
        <>
      <h2 id="lecture-next-action" className="text-section-title">
        {lecture.state === "waiting_for_scenario"
          ? "Scenario is being prepared"
          : lecture.state === "in_progress" ||
              (lecture.state === "completed" && lecture.activeRunId)
            ? "Continue your scenario"
            : lecture.state === "completed"
              ? courseComplete
                ? copy.doneHeading
                : "Scenario complete"
              : "Start the scenario"}
      </h2>

      {lecture.state === "completed" ? (
        <div className="space-y-4">
          {!lecture.activeRunId ? (
            <p className="text-support text-muted-foreground">
              {copy.doneText}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {!lecture.activeRunId ? (courseComplete ? backToCourse : continueLink) : null}
            <LinkedLectureAction
              lecture={lecture}
              route={route}
            />
          </div>
        </div>
      ) : (
        <LinkedLectureAction
          lecture={lecture}
          route={route}
        />
      )}
        </>
      )}

      {!isTheoryOnly &&
      (lecture.state === "waiting_for_scenario" || lecture.scenarioReady === false) ? (
        <p role="status" className="text-support text-muted-foreground">
          {lecture.state === "completed"
            ? "Run again will become available when the scenario image is ready."
            : "The theory is ready. The scenario action will become available when its image is ready."}
        </p>
      ) : null}
      {completeError ? (
        <InlineFeedback tone="error">
          {completeError instanceof Error
            ? completeError.message
            : "Could not complete this lecture."}
        </InlineFeedback>
      ) : null}
      <p role="status" className="sr-only">
        {justDone ? copy.announcement : ""}
      </p>
      </div>
    </section>
  );
}

function LinkedLectureAction({
  lecture,
  route,
}: {
  lecture: CourseLectureDetail;
  route: CourseRouteRef;
}) {
  if (
    lecture.state === "in_progress" ||
    (lecture.state === "completed" && lecture.activeRunId)
  ) {
    return lecture.activeRunId ? (
      <Button
        className="w-full [@media(pointer:coarse)]:min-h-11 sm:w-auto"
        render={<Link to="/runs/$runId" params={{ runId: lecture.activeRunId }} />}
      >
        Resume scenario
        <ArrowRight className="size-4" />
      </Button>
    ) : (
      <InlineFeedback tone="pending">Loading your active scenario…</InlineFeedback>
    );
  }
  if (lecture.state === "waiting_for_scenario" || lecture.scenarioReady === false) {
    return (
      <Button
        disabled
        variant={lecture.state === "completed" ? "outline" : "default"}
        className="w-full [@media(pointer:coarse)]:min-h-11 sm:w-auto"
      >
        Scenario preparing
      </Button>
    );
  }
  if (lecture.state === "locked") {
    return (
      <p className="inline-flex items-center gap-2 text-support text-muted-foreground">
        <LockKeyhole className="size-4" aria-hidden />
        Complete the required lecture first.
      </p>
    );
  }
  const rerun = lecture.state === "completed";
  if (!lecture.scenarioId) return null;
  return (
    <Button
      variant={rerun ? "outline" : "default"}
      className="w-full [@media(pointer:coarse)]:min-h-11 sm:w-auto"
      render={
        <Link
          to="/runs/start/$scenarioId"
          params={{ scenarioId: lecture.scenarioId }}
          search={{
            scope: route.scope,
            organizationId: route.organizationId ?? undefined,
            courseId: route.courseId,
            lectureId: lecture.lectureId,
          }}
          onClick={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            prepareScenarioRunStart(lecture.scenarioId!);
          }}
        />
      }
    >
      {rerun ? "Run again" : "Start scenario"}
      {rerun ? <RotateCcw className="size-4" /> : <ArrowRight className="size-4" />}
    </Button>
  );
}

/** Starts timing and terminal asset work at the learner action. */
function prepareScenarioRunStart(scenarioId: string) {
  clearPendingScenarioRunBootEvidence(scenarioId);
  beginScenarioRunBootEvidence(scenarioId);
  void import("@/components/remote-access/WebSshTerminal")
    .then(() => {
      markPendingScenarioRunBootStage(scenarioId, "terminal-module");
    })
    .catch(() => {
      // The lazy boundary reports a module failure when the terminal is shown.
    });
  void loadReplayTerminalFont()
    .then((loaded) => {
      if (loaded) {
        markPendingScenarioRunBootStage(scenarioId, "terminal-font");
      }
    })
    .catch(() => {
      // Font loading is best effort and must not delay navigation.
    });
}

function lectureBreadcrumbLabels(route: CourseRouteRef, courseTitle: string) {
  switch (route.scope) {
    case "public":
      return { [`/courses/${route.courseId}`]: courseTitle };
    case "organization-public":
      return route.organizationId
        ? {
            [`/organizations/${route.organizationId}/courses/public/${route.courseId}`]:
              courseTitle,
          }
        : undefined;
    case "organization-private":
      return route.organizationId
        ? {
            [`/organizations/${route.organizationId}/courses/private/${route.courseId}`]:
              courseTitle,
          }
        : undefined;
  }
}

function courseMatchesRoute(
  course: CourseCatalogCourse,
  route: CourseRouteRef,
) {
  if (course.courseId !== route.courseId) return false;
  return route.scope === "organization-private"
    ? course.organizationId === route.organizationId
    : course.organizationId === null;
}

function LectureLoading() {
  return (
    <div role="status" aria-busy="true" className="space-y-8">
      <span className="sr-only">Loading lecture…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-5 w-full max-w-[46ch]" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="max-w-[36em] space-y-3">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-3/5" />
      </div>
      <Skeleton className="h-24 max-w-[46rem] rounded-2xl" />
    </div>
  );
}
