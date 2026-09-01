import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, BookOpen, LockKeyhole } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import {
  ScenarioStartCancelledError,
  requestScenarioStartWithCapacityWait,
} from "@/components/app/lib/scenario-start";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { MetaDifficulty, MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CourseLink, LectureLink } from "./course-links";
import {
  CourseLectureLockedError,
  completeCourseLecture,
  courseCatalogQueryKey,
  fetchCourseLecture,
  lectureStatePresentation,
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const startAbortRef = useRef<AbortController | null>(null);
  const [waitingForCapacity, setWaitingForCapacity] = useState(false);
  const [startNotice, setStartNotice] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: ["courses", "lecture", route.organizationId, route.courseId, lectureId],
    queryFn: () => fetchCourseLecture(route, lectureId),
    staleTime: 0,
    retry: (failureCount, error) =>
      !(error instanceof CourseLectureLockedError) && failureCount < 2,
  });
  const lockedError =
    detailQuery.error instanceof CourseLectureLockedError
      ? detailQuery.error
      : null;
  // Never render a cached lecture body when the server now reports a lock.
  const detail = lockedError ? null : (detailQuery.data ?? null);

  useEffect(
    () => () => {
      startAbortRef.current?.abort();
    },
    [],
  );

  const complete = useMutation({
    mutationFn: () => completeCourseLecture(route, lectureId),
    onSuccess: (next) => {
      queryClient.setQueryData(
        ["courses", "lecture", route.organizationId, route.courseId, lectureId],
        next,
      );
      void queryClient.invalidateQueries({
        queryKey: courseCatalogQueryKey(route.organizationId),
      });
    },
  });

  const startScenario = useMutation({
    mutationFn: async () => {
      const scenarioId = detail?.lecture.scenarioId;
      if (!scenarioId) throw new Error("This lecture has no scenario.");
      const controller = new AbortController();
      startAbortRef.current = controller;
      setStartNotice(null);
      setWaitingForCapacity(false);
      return requestScenarioStartWithCapacityWait(scenarioId, {
        signal: controller.signal,
        onCapacityWait: () => setWaitingForCapacity(true),
        organizationId: route.organizationId,
      });
    },
    onSuccess: ({ runId }) => {
      void queryClient.invalidateQueries({
        queryKey: courseCatalogQueryKey(route.organizationId),
      });
      void navigate({ to: "/runs/$runId", params: { runId } });
    },
    onSettled: () => {
      startAbortRef.current = null;
      setWaitingForCapacity(false);
    },
  });

  const breadcrumbLabels = useMemo(
    () => (detail ? lectureBreadcrumbLabels(route, detail.course.title) : undefined),
    [detail, route],
  );
  usePageChrome({ title: detail?.lecture.title ?? "Lecture", breadcrumbLabels });

  if (lockedError) {
    const blocker = lockedError.blockedBy;
    return (
      <PageShell width="content">
        <EmptyState
          className="prose-measure"
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
                className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Open required lecture
                <ArrowRight className="size-4" />
              </LectureLink>
            ) : undefined
          }
        />
      </PageShell>
    );
  }
  if (detailQuery.error && !detail) {
    return (
      <PageShell width="content">
        <ErrorState
          className="prose-measure"
          title="Could not load this lecture"
          description={
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : "Try again to read this lecture."
          }
          onRetry={() => void detailQuery.refetch()}
        />
      </PageShell>
    );
  }
  if (!detail) {
    return <LectureLoading />;
  }

  return (
    <PageShell width="content">
      <div className="prose-measure space-y-6">
        {detailQuery.error ? (
          <Alert>
            <AlertTitle>Lecture status may be out of date</AlertTitle>
            <AlertDescription>
              The last available theory is shown. Refresh before you start the scenario.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-4">
          <CourseLink
            route={route}
            className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back to {detail.course.title}
          </CourseLink>
          <ContentHeader
            title={detail.lecture.title}
            summary={detail.lecture.summary}
            meta={<LectureMeta lecture={detail.lecture} />}
          />
        </div>

        <section aria-label="Lecture content" className="text-body leading-7">
          <Markdown pageContent>{detail.lecture.bodyMarkdown}</Markdown>
        </section>

        <LectureActionPanel
          lecture={detail.lecture}
          route={route}
          completePending={complete.isPending}
          completeError={complete.error}
          onComplete={() => complete.mutate()}
          startPending={startScenario.isPending}
          startError={startScenario.error}
          waitingForCapacity={waitingForCapacity}
          startNotice={startNotice}
          onStart={() => startScenario.mutate()}
          onStopWaiting={() => {
            startAbortRef.current?.abort();
            setWaitingForCapacity(false);
            setStartNotice("Stopped waiting. You can try again when you are ready.");
          }}
        />
      </div>
    </PageShell>
  );
}

function LectureMeta({ lecture }: { lecture: CourseLectureDetail }) {
  const state = lectureStatePresentation(lecture.state);
  return (
    <MetaLine
      items={[
        <StatusToken key="status" tone={state.tone} word={state.word} />,
        lecture.category || null,
        lecture.difficulty ? (
          <MetaDifficulty key="difficulty" difficulty={lecture.difficulty} />
        ) : null,
        lecture.estimatedMinutes ? `~${lecture.estimatedMinutes} min` : null,
        lecture.scenarioId ? "Lecture and scenario" : "Theory lecture",
      ]}
    />
  );
}

function LectureActionPanel({
  lecture,
  route,
  completePending,
  completeError,
  onComplete,
  startPending,
  startError,
  waitingForCapacity,
  startNotice,
  onStart,
  onStopWaiting,
}: {
  lecture: CourseLectureDetail;
  route: CourseRouteRef;
  completePending: boolean;
  completeError: unknown;
  onComplete: () => void;
  startPending: boolean;
  startError: unknown;
  waitingForCapacity: boolean;
  startNotice: string | null;
  onStart: () => void;
  onStopWaiting: () => void;
}) {
  const isTheoryOnly = !lecture.scenarioId;
  const next = lecture.nextLecture;
  const nextRoute = next ? { ...route, courseId: next.courseId } : route;
  const completeButton = (
    <Button onClick={onComplete} disabled={completePending} className="w-full sm:w-auto">
      {completePending ? "Completing lecture…" : "Complete lecture"}
      <ArrowRight className="size-4" />
    </Button>
  );

  return (
    <section
      aria-labelledby="lecture-next-action"
      className="space-y-4 border-y border-brand-border bg-brand-subtle/55 px-4 py-5 sm:px-5"
    >
      <div className="space-y-1">
        <h2 id="lecture-next-action" className="text-section-title">
          {isTheoryOnly
            ? lecture.state === "completed"
              ? "Lecture complete"
              : "Mark this lecture complete"
            : lecture.state === "waiting_for_scenario"
              ? "Scenario is being prepared"
              : lecture.state === "in_progress"
                ? "Continue your scenario"
                : lecture.state === "completed"
                  ? "Scenario complete"
                  : "Start the scenario"}
        </h2>
      </div>

      {isTheoryOnly ? (
        lecture.state === "completed" ? (
          <NextLectureLink next={next} route={nextRoute} />
        ) : (
          completeButton
        )
      ) : (
        <LinkedLectureAction
          lecture={lecture}
          startPending={startPending}
          onStart={onStart}
        />
      )}

      {lecture.state === "waiting_for_scenario" ? (
        <p role="status" className="text-support text-muted-foreground">
          The theory is ready. The scenario action will become available when its image is ready.
        </p>
      ) : null}
      {lecture.state === "completed" && !isTheoryOnly ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" render={<Link to="/runs" />}>
            Review runs
          </Button>
          <NextLectureLink next={next} route={nextRoute} />
        </div>
      ) : null}
      {completeError ? (
        <InlineFeedback tone="error">
          {completeError instanceof Error
            ? completeError.message
            : "Could not complete this lecture."}
        </InlineFeedback>
      ) : null}
      {startError && !(startError instanceof ScenarioStartCancelledError) ? (
        <InlineFeedback tone="error">
          {startError instanceof Error
            ? startError.message
            : "Could not start the scenario."}
        </InlineFeedback>
      ) : null}
      {startNotice ? (
        <p role="status" className="text-support text-muted-foreground">
          {startNotice}
        </p>
      ) : null}
      {startPending ? (
        <div className="space-y-2">
          <InlineFeedback tone="pending">
            {waitingForCapacity
              ? "A practice machine is busy. Retrying for up to 60 seconds."
              : "Preparing your practice machine…"}
          </InlineFeedback>
          {waitingForCapacity ? (
            <Button type="button" variant="outline" onClick={onStopWaiting}>
              Stop waiting
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LinkedLectureAction({
  lecture,
  startPending,
  onStart,
}: {
  lecture: CourseLectureDetail;
  startPending: boolean;
  onStart: () => void;
}) {
  if (lecture.state === "in_progress") {
    return lecture.activeRunId ? (
      <Button
        className="w-full sm:w-auto"
        render={<Link to="/runs/$runId" params={{ runId: lecture.activeRunId }} />}
      >
        Resume scenario
        <ArrowRight className="size-4" />
      </Button>
    ) : (
      <p role="status" className="text-support text-muted-foreground">
        Loading your active scenario…
      </p>
    );
  }
  if (lecture.state === "waiting_for_scenario" || lecture.scenarioReady === false) {
    return (
      <Button disabled className="w-full sm:w-auto">
        Scenario preparing
      </Button>
    );
  }
  if (lecture.state === "completed") return null;
  if (lecture.state === "locked") {
    return (
      <p className="inline-flex items-center gap-2 text-support text-muted-foreground">
        <LockKeyhole className="size-4" aria-hidden />
        Complete the required lecture first.
      </p>
    );
  }
  return (
    <Button onClick={onStart} disabled={startPending} className="w-full sm:w-auto">
      {startPending ? "Starting scenario…" : "Start scenario"}
      <ArrowRight className="size-4" />
    </Button>
  );
}

function NextLectureLink({
  next,
  route,
}: {
  next: CourseLectureDetail["nextLecture"];
  route: CourseRouteRef;
}) {
  return next ? (
    <Button
      render={
        <LectureLink route={route} lectureId={next.lectureId}>
          Next lecture: {next.title}
          <ArrowRight className="size-4" />
        </LectureLink>
      }
    />
  ) : (
    <p className="inline-flex items-center gap-2 text-support text-muted-foreground">
      <BookOpen className="size-4" aria-hidden />
      You completed this course.
    </p>
  );
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

function LectureLoading() {
  return (
    <PageShell width="content">
      <div role="status" className="prose-measure space-y-8">
        <span className="sr-only">Loading lecture…</span>
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-5/6" />
        <div className="space-y-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      </div>
    </PageShell>
  );
}
