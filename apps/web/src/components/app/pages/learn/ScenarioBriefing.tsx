import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaDifficulty, MetaLine } from "@/components/app/patterns/MetaLine";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { formatDurationMs } from "@/components/app/lib/format";
import { repairObjectiveTitle } from "@/lib/verification-copy";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { presentScenarioDetail, presentScenarioRun } from "@/lib/run-phase";
import type { ScenarioDetail } from "@/lib/scenario-runs";
import {
  matchesCourseRoute,
  type CourseRouteMatch,
} from "@/lib/course-location";
import {
  requestScenarioStartWithCapacityWait,
  ScenarioStartCancelledError,
} from "@/components/app/lib/scenario-start";
import {
  HttpResponseError,
  isAccessResponseError,
  pollingIntervalUnlessAccessError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";
import { cn } from "@/lib/utils";
import type { CatalogSearch } from "./catalog-search";
import { CourseCatalogLink } from "./course-route-links";

type PresentedScenarioDetail = ReturnType<typeof presentScenarioDetail>;

interface ScenarioDetailResponse {
  scenario: PresentedScenarioDetail;
}

interface ScenarioBriefingRoute extends CourseRouteMatch {
  organizationId: string | null;
}

export function PublicCourseScenarioBriefing() {
  const { courseId, scenarioId } = useParams({
    from: "/app/courses/$courseId/$scenarioId",
  });
  return (
    <ScenarioBriefing
      route={{ scope: "public", courseId, organizationId: null }}
      scenarioId={scenarioId}
    />
  );
}

export function OrganizationPublicCourseScenarioBriefing() {
  const { orgId, courseId, scenarioId } = useParams({
    from: "/app/organizations/$orgId/courses/public/$courseId/$scenarioId",
  });
  return (
    <ScenarioBriefing
      route={{ scope: "organization-public", courseId, organizationId: orgId }}
      scenarioId={scenarioId}
    />
  );
}

export function OrganizationPrivateCourseScenarioBriefing() {
  const { orgId, courseId, scenarioId } = useParams({
    from: "/app/organizations/$orgId/courses/private/$courseId/$scenarioId",
  });
  return (
    <ScenarioBriefing
      route={{ scope: "organization-private", courseId, organizationId: orgId }}
      scenarioId={scenarioId}
    />
  );
}

export function OrganizationGeneralPracticeScenarioBriefing() {
  const { orgId, scenarioId } = useParams({
    from: "/app/organizations/$orgId/courses/general-practice/$scenarioId",
  });
  return (
    <ScenarioBriefing
      route={{
        scope: "organization-general-practice",
        courseId: "general-practice",
        organizationId: orgId,
      }}
      scenarioId={scenarioId}
    />
  );
}

function ScenarioBriefing({
  route,
  scenarioId,
}: {
  route: ScenarioBriefingRoute;
  scenarioId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as CatalogSearch;
  const organizationId = route.organizationId;
  const [waitingForCapacity, setWaitingForCapacity] = useState(false);
  const [startNotice, setStartNotice] = useState<string | null>(null);
  const startAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      startAbortRef.current?.abort();
    },
    [],
  );

  const scenarioQuery = useQuery({
    queryKey: ["scenarios", "detail", scenarioId, organizationId ?? null],
    queryFn: () => fetchScenarioDetail(scenarioId, organizationId ?? null),
    staleTime: 10_000,
    refetchInterval: (query) =>
      pollingIntervalUnlessAccessError(
        query.state.error,
        query.state.data?.scenario.hasActiveRun
          ? 1_500
          : query.state.data?.scenario.blockingRun
            ? 5_000
            : false,
      ),
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    retry: retryHttpResponseError,
  });

  const startScenario = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      startAbortRef.current = controller;
      setWaitingForCapacity(false);
      setStartNotice(null);
      return requestScenarioStartWithCapacityWait(scenarioId, {
        signal: controller.signal,
        onCapacityWait: () => setWaitingForCapacity(true),
        organizationId:
          scenarioQuery.data?.scenario.courseLocation?.organizationId ??
          organizationId ??
          null,
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["scenarios", "run", result.runId], {
        run: presentScenarioRun(result.run),
      });
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["scenarios", "detail", scenarioId],
      });
      void navigate({
        to: "/runs/$runId",
        params: { runId: result.runId },
      });
    },
    onSettled: () => {
      startAbortRef.current = null;
      setWaitingForCapacity(false);
    },
  });

  const scenarioAccessError = isAccessResponseError(scenarioQuery.error, true);
  const scenarioData = scenarioAccessError
    ? null
    : (scenarioQuery.data?.scenario ?? null);
  const routeMatchesCatalog = matchesCourseRoute(
    scenarioData?.courseLocation,
    route,
  );
  const finishedRuns = scenarioData?.finishedRuns ?? [];
  // A solve counts even when teardown later failed or the run was destroyed
  // afterwards — same semantics as the catalog's ScenarioProgress.
  const succeededRuns = finishedRuns.filter((run) => run.solvedAt !== null);
  const breadcrumbLabels = useMemo(
    () => courseBreadcrumbLabels(route, scenarioData?.courseLocation),
    [route, scenarioData?.courseLocation],
  );
  usePageChrome({
    // Do not expose the route's scenario ID while the briefing is loading.
    title: scenarioData?.briefing.title ?? "Lab",
    breadcrumbLabels,
  });

  const bestSolveMs = succeededRuns
    .filter((run) => run.solveDurationMs !== null)
    .reduce<
      number | null
    >((best, run) => (best === null ? run.solveDurationMs : Math.min(best, run.solveDurationMs ?? best)), null);

  const handlePrimaryAction = () => {
    if (scenarioData?.hasActiveRun && scenarioData.activeRunId) {
      void navigate({
        to: "/runs/$runId",
        params: { runId: scenarioData.activeRunId },
      });
      return;
    }

    startScenario.mutate();
  };

  const stopWaitingForCapacity = () => {
    startAbortRef.current?.abort();
    setWaitingForCapacity(false);
    setStartNotice("Stopped waiting. You can try again when you are ready.");
  };

  return (
    <PageShell width="content" density="comfortable">
      {scenarioQuery.error && !scenarioData ? (
        <ErrorState
          title="Could not load this lab"
          description="Check your connection and try again."
          onRetry={() => void scenarioQuery.refetch()}
        />
      ) : !scenarioData ? (
        <div role="status" className="space-y-8">
          <span className="sr-only">Loading…</span>
          <div className="space-y-2">
            <Skeleton className="h-7 w-72 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
            <Skeleton className="h-3 w-64" />
          </div>
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        </div>
      ) : !routeMatchesCatalog ? (
        <ErrorState
          title="Scenario is not in this course"
          description="This course path no longer contains the selected scenario. Open the current course catalog to choose an available lab."
          onRetry={() => void scenarioQuery.refetch()}
        />
      ) : (
        <>
          {scenarioQuery.error ? (
            <Alert>
              <RefreshCw aria-hidden="true" />
              <AlertTitle>Run status may be out of date</AlertTitle>
              <AlertDescription>
                The last loaded briefing is still available. Retry to refresh
                the current run state.
              </AlertDescription>
              <AlertAction>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void scenarioQuery.refetch()}
                  disabled={scenarioQuery.isFetching}
                >
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

          <div className="space-y-8">
            <div className="space-y-4">
              <CourseCatalogLink
                location={scenarioData.courseLocation}
                search={routeSearch}
                className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                <ArrowLeft className="size-4" aria-hidden />
                Back to course
              </CourseCatalogLink>

              <ContentHeader
                title={scenarioData.briefing.title}
                summary={scenarioData.briefing.tagline}
                meta={
                  <MetaLine
                    items={[
                      <MetaDifficulty
                        key="difficulty"
                        difficulty={scenarioData.briefing.difficulty}
                      />,
                      `about ${scenarioData.briefing.estimatedMinutes} minutes`,
                      scenarioData.courseLocation?.step &&
                      scenarioData.courseLocation.steps
                        ? `step ${scenarioData.courseLocation.step} of ${scenarioData.courseLocation.steps}`
                        : null,
                    ]}
                  />
                }
              />
            </div>

            <ScenarioActionPanel
              scenario={scenarioData}
              isPending={startScenario.isPending}
              waitingForCapacity={waitingForCapacity}
              error={startScenario.error}
              notice={startNotice}
              onPrimaryAction={handlePrimaryAction}
              onStopWaiting={stopWaitingForCapacity}
            />

            <section className="space-y-4" aria-labelledby="your-task-heading">
              <div>
                <h2 id="your-task-heading" className="text-section-title">
                  Your task
                </h2>
              </div>
              <div className="prose-measure text-body leading-7">
                <Markdown>{scenarioData.briefing.briefingMarkdown}</Markdown>
              </div>
            </section>

            {scenarioData.briefing.objectives.length ? (
              <Card as="section" aria-labelledby="done-when-heading">
                <CardHeader className="gap-2 border-b">
                  <CardTitle
                    as="h2"
                    id="done-when-heading"
                    className="text-section-title"
                  >
                    Done when
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="divide-y">
                    {scenarioData.briefing.objectives.map(
                      (objective, index) => (
                        <li
                          key={`${objective.probeName}-${index}`}
                          className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 py-4 first:pt-0 last:pb-0"
                        >
                          <span className="font-heading text-sm font-semibold text-brand-text tabular-nums">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="min-w-0 space-y-1">
                            <p className="font-semibold">
                              {repairObjectiveTitle(objective, index)}
                            </p>
                          </div>
                        </li>
                      ),
                    )}
                  </ol>
                </CardContent>
              </Card>
            ) : null}

            <aside
              aria-label="Guidance"
              className="border-y py-4 text-sm leading-6 text-muted-foreground"
            >
              Guidance is available while you work.
            </aside>

            <ScenarioProgressSummary
              hasActiveRun={scenarioData.hasActiveRun}
              finishedRunCount={finishedRuns.length}
              solvedRunCount={succeededRuns.length}
              bestSolveMs={bestSolveMs}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}

function ScenarioActionPanel({
  scenario,
  isPending,
  waitingForCapacity,
  error,
  notice,
  onPrimaryAction,
  onStopWaiting,
}: {
  scenario: PresentedScenarioDetail;
  isPending: boolean;
  waitingForCapacity: boolean;
  error: unknown;
  notice: string | null;
  onPrimaryAction: () => void;
  onStopWaiting: () => void;
}) {
  return (
    <section
      className="space-y-3 rounded-xl border border-brand-border bg-brand-subtle p-4 sm:p-5"
      aria-labelledby="scenario-next-action"
    >
      <div>
        <h2 id="scenario-next-action" className="text-section-title">
          {scenario.hasActiveRun
            ? "Continue your lab"
            : "Start your lab"}
        </h2>
      </div>
      <Button
        className="w-full sm:w-auto sm:min-w-44"
        onClick={onPrimaryAction}
        disabled={
          isPending ||
          scenario.blockingRun !== null ||
          (scenario.hasActiveRun && !scenario.activeRunId)
        }
      >
        {isPending
          ? "Starting lab…"
          : scenario.hasActiveRun
            ? "Continue lab"
            : "Start lab"}
        <ArrowRight className="size-4" />
      </Button>
      {scenario.blockingRun ? (
        <div className="space-y-3 border-t border-brand-border pt-4">
          <p className="text-sm leading-6 text-muted-foreground">
            Finish your other lab before you start this one.
          </p>
          <Button
            variant="outline"
            className="w-full sm:w-auto sm:min-w-44"
            render={
              <Link
                to="/runs/$runId"
                params={{ runId: scenario.blockingRun.runId }}
              />
            }
          >
            Open active lab
            <ArrowRight className="size-4" />
          </Button>
        </div>
      ) : error && !(error instanceof ScenarioStartCancelledError) ? (
        <InlineFeedback tone="error">
          We could not start the lab. Try again in a moment.
        </InlineFeedback>
      ) : notice ? (
        <p role="status" className="text-sm leading-6 text-muted-foreground">
          {notice}
        </p>
      ) : isPending ? (
        <div className="space-y-2">
          <InlineFeedback tone="pending">
            {waitingForCapacity
              ? "A practice machine is busy. Retrying automatically for up to 60 seconds."
              : "Preparing your practice machine…"}
          </InlineFeedback>
          {waitingForCapacity ? (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={onStopWaiting}
            >
              Stop waiting
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ScenarioProgressSummary({
  hasActiveRun,
  finishedRunCount,
  solvedRunCount,
  bestSolveMs,
  className,
}: {
  hasActiveRun: boolean;
  finishedRunCount: number;
  solvedRunCount: number;
  bestSolveMs: number | null;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 border-y py-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      aria-labelledby="your-progress-heading"
    >
      <div className="space-y-1">
        <p className="text-label">Your progress</p>
        <h2 id="your-progress-heading" className="text-card-title">
          {hasActiveRun
            ? "Lab in progress"
            : finishedRunCount === 0
              ? "No runs yet"
              : `${solvedRunCount} of ${finishedRunCount} runs solved`}
        </h2>
        {bestSolveMs !== null ? (
          <p className="text-metadata">
            Best solve time: {formatDurationMs(bestSolveMs)}
          </p>
        ) : null}
      </div>
      <Link
        to="/runs"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-text underline-offset-4 hover:underline"
      >
        View all runs
      </Link>
    </section>
  );
}

async function fetchScenarioDetail(
  scenarioId: string,
  organizationId: string | null,
) {
  const query = organizationId
    ? `?organizationId=${encodeURIComponent(organizationId)}`
    : "";
  const response = await fetch(
    `/api/scenarios/${encodeURIComponent(scenarioId)}${query}`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new HttpResponseError(
      response.status,
      body?.error ?? `Failed to load scenario (${response.status})`,
    );
  }

  const body = (await response.json()) as {
    scenario: ScenarioDetail;
  };
  return {
    scenario: presentScenarioDetail(body.scenario),
  } satisfies ScenarioDetailResponse;
}

function courseBreadcrumbLabels(
  route: ScenarioBriefingRoute,
  location: PresentedScenarioDetail["courseLocation"] | undefined,
): Record<string, string> | undefined {
  if (!location) return undefined;
  switch (route.scope) {
    case "public":
      return { [`/courses/${route.courseId}`]: location.courseTitle };
    case "organization-public":
      return {
        [`/organizations/${route.organizationId}/courses/public/${route.courseId}`]:
          location.courseTitle,
      };
    case "organization-private":
      return {
        [`/organizations/${route.organizationId}/courses/private/${route.courseId}`]:
          location.courseTitle,
      };
    case "organization-general-practice":
      return {
        [`/organizations/${route.organizationId}/courses/general-practice`]:
          location.courseTitle,
      };
  }
}
