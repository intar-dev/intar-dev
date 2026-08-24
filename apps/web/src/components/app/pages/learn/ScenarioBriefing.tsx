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
  ChevronDown,
  History,
  RefreshCw,
  Trash2,
  Trophy,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaDifficulty, MetaLine } from "@/components/app/patterns/MetaLine";
import { RunListItem } from "@/components/app/patterns/RunListItem";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { formatDurationMs, formatTimestamp } from "@/components/app/lib/format";
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
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CatalogSearch } from "./catalog-search";
import { CourseCatalogLink } from "./course-route-links";

type PresentedScenarioDetail = ReturnType<typeof presentScenarioDetail>;
type FinishedRun = PresentedScenarioDetail["finishedRuns"][number];

interface DeleteTarget {
  run: FinishedRun;
  attemptNumber: number;
}

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
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
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

  const deleteRun = useMutation({
    mutationFn: async (runId: string) => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to delete run (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      setDeleteTarget(null);
      await Promise.all([
        scenarioQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] }),
        queryClient.invalidateQueries({ queryKey: ["scenario-runs", "list"] }),
      ]);
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
  // finishedRuns arrives newest-first from the API.
  const runsWithAttemptNumbers = finishedRuns.map((run, index) => ({
    run,
    attemptNumber: finishedRuns.length - index,
  }));
  const latestRun = runsWithAttemptNumbers[0] ?? null;
  const olderRuns = runsWithAttemptNumbers.slice(1);
  const solved = succeededRuns.length > 0;
  const breadcrumbLabels = useMemo(
    () => courseBreadcrumbLabels(route, scenarioData?.courseLocation),
    [route, scenarioData?.courseLocation],
  );
  usePageChrome({
    title: scenarioData?.briefing.title,
    status: useMemo(
      () => (solved ? <Badge variant="success">Solved</Badge> : undefined),
      [solved],
    ),
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
          title="Could not load scenario"
          description={
            scenarioQuery.error instanceof Error
              ? scenarioQuery.error.message
              : "Failed to load scenario briefing"
          }
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
              badge={solved ? <Badge variant="success">Solved</Badge> : undefined}
              summary={scenarioData.briefing.tagline}
              meta={
                <MetaLine
                  items={[
                    scenarioData.courseLocation?.step &&
                    scenarioData.courseLocation.steps
                      ? `Course step ${scenarioData.courseLocation.step} of ${scenarioData.courseLocation.steps}`
                      : null,
                    scenarioData.briefing.category,
                    <MetaDifficulty
                      key="difficulty"
                      difficulty={scenarioData.briefing.difficulty}
                    />,
                    `~${scenarioData.briefing.estimatedMinutes} min`,
                    scenarioData.vmCount === 1
                      ? "1 machine"
                      : `${scenarioData.vmCount} machines`,
                  ]}
                />
              }
            />
          </div>

          <ScenarioActionPanel
            headingId="scenario-next-action-mobile"
            scenario={scenarioData}
            isPending={startScenario.isPending}
            waitingForCapacity={waitingForCapacity}
            error={startScenario.error}
            notice={startNotice}
            onPrimaryAction={handlePrimaryAction}
            onStopWaiting={stopWaitingForCapacity}
            className="lg:hidden"
          />

          <ScenarioProgressSummary
            activeRun={scenarioData.activeRun}
            finishedRunCount={finishedRuns.length}
            solvedRunCount={succeededRuns.length}
            bestSolveMs={bestSolveMs}
            className="lg:hidden"
          />

          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="space-y-12">
              {scenarioData.briefing.objectives.length ? (
                <Card as="section" aria-labelledby="objectives-heading">
                  <CardHeader className="gap-2 border-b">
                    <p className="text-eyebrow">Work order</p>
                    <CardTitle
                      as="h2"
                      id="objectives-heading"
                      className="text-section-title"
                    >
                      Repair objectives
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
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <p className="font-semibold">
                                  {repairObjectiveTitle(objective, index)}
                                </p>
                                {scenarioData.vmCount > 1 ? (
                                  <code className="text-caption">
                                    {objective.vmName}
                                  </code>
                                ) : null}
                              </div>
                              {objective.bodyMarkdown ? (
                                <Markdown className="text-muted-foreground [&_code]:text-foreground">
                                  {objective.bodyMarkdown}
                                </Markdown>
                              ) : null}
                              {objective.hintCount > 0 ? (
                                <p className="text-metadata">
                                  {objective.hintCount} hint
                                  {objective.hintCount === 1 ? "" : "s"}{" "}
                                  available
                                </p>
                              ) : null}
                            </div>
                          </li>
                        ),
                      )}
                    </ol>
                  </CardContent>
                </Card>
              ) : null}

              <section className="space-y-4" aria-labelledby="briefing-heading">
                <div>
                  <p className="text-eyebrow">Incident context</p>
                  <h2 id="briefing-heading" className="mt-2 text-section-title">
                    Briefing
                  </h2>
                </div>
                <div className="prose-measure text-body leading-7">
                  <Markdown>{scenarioData.briefing.briefingMarkdown}</Markdown>
                </div>
              </section>

              <details className="rounded-lg border bg-card">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm font-semibold marker:hidden">
                  <ChevronDown className="size-4 text-muted-foreground" />
                  Technical details
                </summary>
                <div className="border-t px-4 py-2">
                  <dl className="divide-y text-sm">
                    <TechnicalDetail label="Scenario ID">
                      <code className="break-all">
                        {scenarioData.scenarioId}
                      </code>
                    </TechnicalDetail>
                    <TechnicalDetail label="Definition">
                      <code className="break-all">
                        {scenarioData.scenarioName}
                      </code>
                    </TechnicalDetail>
                    <TechnicalDetail label="Published">
                      {formatTimestamp(scenarioData.enabledAt)}
                    </TechnicalDetail>
                    <TechnicalDetail label="Tags">
                      {scenarioData.briefing.tags.length
                        ? scenarioData.briefing.tags.join(", ")
                        : "None"}
                    </TechnicalDetail>
                  </dl>
                </div>
              </details>
            </div>

            <aside className="hidden space-y-6 lg:sticky lg:top-24 lg:block">
              <ScenarioActionPanel
                headingId="scenario-next-action-desktop"
                scenario={scenarioData}
                isPending={startScenario.isPending}
                waitingForCapacity={waitingForCapacity}
                error={startScenario.error}
                notice={startNotice}
                onPrimaryAction={handlePrimaryAction}
                onStopWaiting={stopWaitingForCapacity}
              />
              <ScenarioProgressSummary
                activeRun={scenarioData.activeRun}
                finishedRunCount={finishedRuns.length}
                solvedRunCount={succeededRuns.length}
                bestSolveMs={bestSolveMs}
              />
            </aside>
          </div>

          {finishedRuns.length ? (
            <section
              className="space-y-4"
              aria-labelledby="previous-runs-heading"
            >
              <div className="flex items-center gap-3 border-b pb-4">
                <History className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-eyebrow">History</p>
                  <h2
                    id="previous-runs-heading"
                    className="mt-1 text-section-title"
                  >
                    Previous runs
                  </h2>
                </div>
              </div>
              {latestRun ? (
                <div className="overflow-hidden rounded-xl border bg-card">
                  <div className="border-b bg-muted/30 px-4 py-2 sm:px-6">
                    <p className="text-metadata font-semibold">
                      Latest attempt
                    </p>
                  </div>
                  <PreviousRunRow
                    run={latestRun.run}
                    attemptNumber={latestRun.attemptNumber}
                    scenarioTitle={scenarioData.briefing.title}
                    courseLocation={scenarioData.courseLocation}
                    onDelete={() =>
                      setDeleteTarget({
                        run: latestRun.run,
                        attemptNumber: latestRun.attemptNumber,
                      })
                    }
                  />
                </div>
              ) : null}
              {olderRuns.length ? (
                <Collapsible>
                  <CollapsibleTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Show ${olderRuns.length} older attempts for ${scenarioData.briefing.title}`}
                      />
                    }
                  >
                    Show {olderRuns.length} older attempt
                    {olderRuns.length === 1 ? "" : "s"}
                    <ChevronDown className="size-3.5" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-3">
                    <PaginatedCollection
                      items={olderRuns}
                      pageSize={COLLECTION_PAGE_SIZE.list}
                      itemLabel="older runs"
                    >
                      {(visibleRuns) => (
                        <div className="divide-y overflow-hidden rounded-xl border bg-card">
                          {visibleRuns.map(({ run, attemptNumber }) => (
                            <PreviousRunRow
                              key={run.runId}
                              run={run}
                              attemptNumber={attemptNumber}
                              scenarioTitle={scenarioData.briefing.title}
                              courseLocation={scenarioData.courseLocation}
                              onDelete={() =>
                                setDeleteTarget({ run, attemptNumber })
                              }
                            />
                          ))}
                        </div>
                      )}
                    </PaginatedCollection>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </section>
          ) : null}

          <Dialog
            open={deleteTarget !== null}
            onOpenChange={(open) => {
              if (!open) {
                setDeleteTarget(null);
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  Delete {scenarioData.briefing.title}, attempt{" "}
                  {deleteTarget?.attemptNumber ?? ""}?
                </DialogTitle>
                <DialogDescription>
                  This permanently removes this run, its checks, and its replay
                  from your history. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleteRun.isPending}
                >
                  Keep run
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (deleteTarget) {
                      deleteRun.mutate(deleteTarget.run.runId);
                    }
                  }}
                  disabled={deleteRun.isPending || !deleteTarget}
                  aria-label={`Delete ${scenarioData.briefing.title}, attempt ${deleteTarget?.attemptNumber ?? ""}`}
                >
                  <Trash2 className="size-4" />
                  {deleteRun.isPending ? "Deleting…" : "Delete run"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </PageShell>
  );
}

function ScenarioActionPanel({
  headingId,
  scenario,
  isPending,
  waitingForCapacity,
  error,
  notice,
  onPrimaryAction,
  onStopWaiting,
  className,
}: {
  headingId: string;
  scenario: PresentedScenarioDetail;
  isPending: boolean;
  waitingForCapacity: boolean;
  error: unknown;
  notice: string | null;
  onPrimaryAction: () => void;
  onStopWaiting: () => void;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "space-y-4 rounded-xl border border-brand-border bg-brand-subtle p-4 sm:p-6",
        className,
      )}
      aria-labelledby={headingId}
    >
      <div>
        <p className="text-eyebrow text-brand-text">Next action</p>
        <h2 id={headingId} className="mt-2 text-section-title">
          {scenario.hasActiveRun
            ? "Continue the repair"
            : "Open a fresh sandbox"}
        </h2>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={onPrimaryAction}
        disabled={
          isPending ||
          scenario.blockingRun !== null ||
          (scenario.hasActiveRun && !scenario.activeRunId)
        }
      >
        {isPending
          ? "Starting scenario…"
          : scenario.hasActiveRun
            ? "Resume run"
            : "Start scenario"}
        <ArrowRight className="size-4" />
      </Button>
      {scenario.blockingRun ? (
        <div className="space-y-3 border-t border-brand-border pt-4">
          <p className="text-sm leading-6 text-muted-foreground">
            An active run on{" "}
            <span className="font-semibold text-foreground">
              {scenario.blockingRun.title}
            </span>{" "}
            must end before another sandbox can start.
          </p>
          <Button
            variant="outline"
            className="w-full"
            render={
              <Link
                to="/runs/$runId"
                params={{ runId: scenario.blockingRun.runId }}
              />
            }
          >
            Go to active run
            <ArrowRight className="size-4" />
          </Button>
        </div>
      ) : error && !(error instanceof ScenarioStartCancelledError) ? (
        <InlineFeedback tone="error">
          {error instanceof Error
            ? error.message
            : "The scenario could not be started."}
        </InlineFeedback>
      ) : notice ? (
        <p role="status" className="text-sm leading-6 text-muted-foreground">
          {notice}
        </p>
      ) : isPending ? (
        <div className="space-y-2">
          <InlineFeedback tone="pending">
            {waitingForCapacity
              ? "VM capacity is temporarily busy. Retrying automatically for up to 60 seconds."
              : "Requesting VM capacity…"}
          </InlineFeedback>
          {waitingForCapacity ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
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
  activeRun,
  finishedRunCount,
  solvedRunCount,
  bestSolveMs,
  className,
}: {
  activeRun: PresentedScenarioDetail["activeRun"];
  finishedRunCount: number;
  solvedRunCount: number;
  bestSolveMs: number | null;
  className?: string;
}) {
  return (
    <div className={cn("space-y-6", className)}>
      {activeRun ? (
        <section className="space-y-2 border-y py-4">
          <p className="text-eyebrow">Live status</p>
          <p className="font-semibold">{activeRun.phaseTitle}</p>
          <p className="text-metadata">{activeRun.phaseDetail}</p>
          <p className="text-caption">
            Updated {formatTimestamp(activeRun.updatedAt)}
          </p>
        </section>
      ) : null}

      {finishedRunCount ? (
        <dl className="grid grid-cols-2 gap-4 border-y py-4">
          <div>
            <dt className="text-eyebrow">Best time</dt>
            <dd className="mt-2 inline-flex items-center gap-2 font-semibold tabular-nums">
              {bestSolveMs !== null ? (
                <>
                  <Trophy className="size-4 text-warning" />
                  {formatDurationMs(bestSolveMs)}
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-eyebrow">Attempts</dt>
            <dd>
              <span className="mt-2 block font-semibold tabular-nums">
                {finishedRunCount}
              </span>
              <span className="block text-caption">{solvedRunCount} solved</span>
            </dd>
          </div>
        </dl>
      ) : null}

      {!finishedRunCount && !activeRun ? (
        <p className="border-y py-4 text-sm text-muted-foreground">
          The browser shell needs no local installation. Native SSH is also
          available after launch.
        </p>
      ) : null}
    </div>
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

function TechnicalDetail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 px-4 py-4 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4 sm:px-6">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium sm:text-right">{children}</dd>
    </div>
  );
}

function PreviousRunRow({
  run,
  attemptNumber,
  scenarioTitle,
  courseLocation,
  onDelete,
}: {
  run: FinishedRun;
  attemptNumber: number;
  scenarioTitle: string;
  courseLocation: PresentedScenarioDetail["courseLocation"];
  onDelete: () => void;
}) {
  return (
    <RunListItem
      run={{
        runId: run.runId,
        title: scenarioTitle,
        outcome: run.outcome,
        active: false,
        createdAt: run.createdAt,
        solveDurationMs: run.solveDurationMs,
        solutionAssisted: run.solutionAssisted,
        hasReplay: run.hasReplay,
        attemptNumber,
        courseLocation,
      }}
      trailing={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${scenarioTitle}, attempt ${attemptNumber}`}
          title={`Delete ${scenarioTitle}, attempt ${attemptNumber}`}
        >
          <Trash2 className="size-4" />
        </Button>
      }
    />
  );
}
