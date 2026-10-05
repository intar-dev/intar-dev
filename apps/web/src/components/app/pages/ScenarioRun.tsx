import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  BookOpen,
  EllipsisVertical,
  ListChecks,
  Share2,
  SquareTerminal,
} from "lucide-react";
import {
  requestScenarioStartWithCapacityWait,
  ScenarioStartCancelledError,
  type ScenarioStartContention,
} from "@/components/app/lib/scenario-start";
import {
  createScenarioStatusRefreshQueue,
  createScenarioStatusTransport,
  parseScenarioRunStatusStreamMessage,
  preferNewerScenarioStatusResult,
  scenarioStatusRevision,
} from "@/components/app/lib/scenario-status-stream";
import {
  RUN_STATUS_HEARTBEAT_INTERVAL_MS,
  RUN_STATUS_PING,
  RUN_STATUS_PONG,
} from "@/lib/run-status-heartbeat";
import {
  HttpResponseError,
  isAccessResponseError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { useJustReached } from "@/components/app/patterns/use-just-reached";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import {
  StatusToken,
  type StatusTone,
} from "@/components/app/patterns/StatusToken";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatClockSeconds } from "@/components/app/lib/format";
import { BinIcon } from "@/components/ui/bin-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { presentScenarioRun } from "@/lib/run-phase";
import {
  courseCatalogQueryKey,
  courseRouteForRun,
  fetchCourseCatalog,
  findNextCourseLecture,
  invalidateCourseCatalogs,
  type CourseCatalogResponse,
  type CourseLectureDetailResponse,
  type CourseRouteRef,
} from "@/components/app/pages/learn/course-wire";
import { RunCompletionBar } from "@/components/app/run/RunCompletionBar";
import { LeaseCountdown } from "@/components/app/run/LeaseCountdown";
import {
  RunCheckBar,
  RunCheckToast,
  RunLearningPanel,
  RunLearningPanelMobile,
  type RunLearningPanelProps,
} from "@/components/app/run/RunLearningPanel";
import {
  RUN_QUERY,
  RunFrameProvider,
  RunSheetProvider,
  useMediaQuery,
  useRunFrame,
  useRunKeyboard,
  useRunSheet,
  useRunSheetController,
} from "@/components/app/run/run-viewport";
import {
  ACTIVE_RUN_STATUS_WORDS,
  planActiveRunStatus,
} from "@/components/app/run/run-status-display";
import { ScenarioVmSelector } from "@/components/app/run/ScenarioVmSelector";
import {
  ScenarioShellStatusCard,
  ScenarioStepScreen,
} from "@/components/app/run/StatusScreens";
import {
  buildScenarioBootSteps,
  buildScenarioStartSteps,
  getScenarioBootScreenCopy,
  hasPendingInfrastructureTeardown,
  hasUsableTerminalTarget,
} from "@/components/app/run/run-support";
import {
  mergeScenarioRunStatus,
  scenarioRunStatusRefetchInterval,
  type ScenarioRunStatus,
  type ScenarioRunResponse,
  type ScenarioDestroyAcceptedResponse,
} from "@/components/app/run/run-types";
import type {
  CourseLocation,
} from "@/lib/scenario-runs";
import { computeLeaseDeadline } from "@/lib/run-lease";
import {
  associateScenarioRunBootEvidence,
  beginScenarioRunBootEvidence,
  clearPendingScenarioRunBootEvidence,
  markPendingScenarioRunBootStage,
  markScenarioRunBootStage,
} from "@/lib/scenario-run-performance";
import { loadReplayTerminalFont } from "@/lib/replay/config";
import { cn } from "@/lib/utils";
import {
  isTransportReadyFor,
  shouldRevealTerminal,
  type TerminalTransportReport,
} from "@/components/app/lib/scenario-terminal-readiness";

const LazyWebSshTerminal = lazy(() =>
  import("@/components/remote-access/WebSshTerminal").then(
    ({ WebSshTerminal }) => ({ default: WebSshTerminal }),
  ),
);
const LazyNativeSshSheet = lazy(() =>
  import("@/components/remote-access/NativeSshSheet").then(
    ({ NativeSshSheet }) => ({ default: NativeSshSheet }),
  ),
);
const LazyRunRecap = lazy(() =>
  import("@/components/app/run/RunRecap").then(({ RunRecap }) => ({
    default: RunRecap,
  })),
);
const LazyScenarioCancelDialog = lazy(() =>
  import("@/components/app/run/RunDialogs").then(
    ({ ScenarioCancelDialog }) => ({ default: ScenarioCancelDialog }),
  ),
);
const LazyDeleteRunDialog = lazy(() =>
  import("@/components/app/run/RunDialogs").then(({ DeleteRunDialog }) => ({
    default: DeleteRunDialog,
  })),
);
const LazyRunShareDialog = lazy(() =>
  import("@/components/app/run/RunShareDialog").then(({ RunShareDialog }) => ({
    default: RunShareDialog,
  })),
);

interface ScenarioRunStatusPollResult {
  status: ScenarioRunStatus | null;
  version: string;
}

export function ScenarioRunStart() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { scenarioId } = useParams({ from: "/app/runs/start/$scenarioId" });
  const search = useSearch({ from: "/app/runs/start/$scenarioId" });
  const organizationId = search.organizationId ?? null;
  const abortRef = useRef<AbortController | null>(null);
  const [startState, setStartState] = useState<
    "requesting" | "waiting" | "failed"
  >("requesting");
  const [startError, setStartError] = useState<string | null>(null);
  // Which refusal the wait is for, so the busy copy is accurate without
  // naming backend internals.
  const [startContention, setStartContention] =
    useState<ScenarioStartContention | null>(null);
  const courseCatalog = useQuery({
    queryKey: courseCatalogQueryKey(organizationId),
    queryFn: () => fetchCourseCatalog(organizationId),
    enabled: Boolean(search.courseId && search.lectureId),
    staleTime: 30_000,
    retry: false,
  });
  const lectureDetail =
    search.courseId && search.lectureId
      ? queryClient.getQueryData<CourseLectureDetailResponse>([
          "courses",
          "lecture",
          organizationId,
          search.courseId,
          search.lectureId,
        ])
      : undefined;
  const title =
    lectureDetail?.lecture.title ??
    findStartLectureTitle(courseCatalog.data, search) ??
    "Scenario run";
  const returnTarget = getStartReturnTarget(search);
  const startGuidanceProps: RunLearningPanelProps = {
    briefingMarkdown: "",
    lectureMarkdown: lectureDetail?.lecture.bodyMarkdown ?? null,
    lectureTitle: lectureDetail?.lecture.title ?? null,
    phase: "launching" as const,
    probes: [],
    objectives: [],
    hints: [],
    solution: {
      unlocked: false,
      revealed: false,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: null,
    },
    checksPending: true,
    onRevealHint: () => undefined,
    onRevealSolution: () => undefined,
  };

  const startScenario = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // Direct navigation has no learner click. The normal lecture action
    // already recorded `start-click` before it navigated here.
    beginScenarioRunBootEvidence(scenarioId, "start-route");
    markPendingScenarioRunBootStage(scenarioId, "start-request");
    setStartState("requesting");
    setStartError(null);
    setStartContention(null);

    void requestScenarioStartWithCapacityWait(scenarioId, {
      signal: controller.signal,
      organizationId,
      onCapacityWait: (contention) => {
        setStartContention(contention);
        setStartState("waiting");
      },
    })
      .then(async ({ runId, run, reused, acceptedAt }) => {
        markPendingScenarioRunBootStage(scenarioId, "start-accepted");
        associateScenarioRunBootEvidence({
          runId,
          scenarioId,
          reused,
          acceptedAt,
        });
        queryClient.setQueryData<ScenarioRunResponse>(
          ["scenarios", "run", runId],
          { run: presentScenarioRun(run) },
        );
        // Mark stale without refetching: this page is about to leave, and the
        // next page that shows them reloads them on mount.
        invalidateCourseCatalogs(queryClient, organizationId, "none");
        void queryClient.invalidateQueries({
          queryKey: ["scenario-runs"],
          refetchType: "none",
        });
        await navigate({
          to: "/runs/$runId",
          params: { runId },
          replace: true,
        });
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          error instanceof ScenarioStartCancelledError
        ) {
          return;
        }
        clearPendingScenarioRunBootEvidence(scenarioId);
        setStartState("failed");
        setStartError(
          error instanceof Error
            ? error.message
            : "Could not start the scenario.",
        );
      });
  }, [navigate, organizationId, queryClient, scenarioId]);

  useEffect(() => {
    startScenario();
    return () => abortRef.current?.abort();
  }, [startScenario]);

  // Try again unmounts the button that holds focus; the sequence heading takes
  // it once the retry has rendered, so keyboard users keep their place.
  const sequenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusSequenceRef = useRef(false);
  useEffect(() => {
    if (focusSequenceRef.current && startState !== "failed") {
      focusSequenceRef.current = false;
      sequenceHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [startState]);

  usePageChrome({ title, fullscreen: true });

  const waitingForCapacity = startState === "waiting";
  const waitingForRegistry =
    waitingForCapacity && startContention === "registry";
  // A registry wait is a wait on admission, not on a machine.
  const waitingForMachineCapacity = waitingForCapacity && !waitingForRegistry;
  const failed = startState === "failed";
  const steps = buildScenarioStartSteps({
    failed,
    detail: failed
      ? "The scenario run could not be created."
      : waitingForRegistry
        ? "Waiting for image maintenance to finish."
        : waitingForMachineCapacity
          ? "Waiting for an available practice machine."
          : "Creating a secure scenario run.",
  });

  return (
    <RunWorkspaceShell
      title={title}
      status={
        <StatusToken
          tone={failed ? "danger" : "pending"}
          word={
            failed
              ? "Could not start"
              : waitingForRegistry
                ? "Waiting to start"
                : waitingForCapacity
                  ? "Waiting for capacity"
                  : "Starting"
          }
          compactWord={
            failed ? "Failed" : waitingForCapacity ? "Waiting" : "Starting"
          }
          pulse={!failed}
        />
      }
      returnTarget={returnTarget}
      guidance={startGuidanceProps}
    >
      <div
        data-run-start-sequence
        role="region"
        aria-label="Workspace startup progress"
        tabIndex={0}
        className="flex min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2 md:px-3 md:pb-3 short:pb-2"
      >
        {/* The same insets as the run page's startup screen, so the card stays
            put when the run page takes the sequence over. */}
        <div className="m-auto w-full py-4 sm:px-1 sm:py-6" data-run-sequence-frame>
          <ScenarioStepScreen
            title={failed ? "The run did not start" : "Preparing your workspace"}
            description={
              failed
                ? (startError ?? "The scenario could not start.")
                : waitingForRegistry
                  ? "Image maintenance is in progress. Retrying for up to 60 seconds."
                  : waitingForCapacity
                    ? "A practice machine is busy. Retrying for up to 60 seconds."
                    : getScenarioBootScreenCopy(null).description
            }
            headingRef={sequenceHeadingRef}
            steps={steps}
            listLabel="Startup steps"
            handoffTo={`run-start:${scenarioId}`}
            {...(waitingForCapacity
              ? {
                  // The wait changes the description and stage 1's detail, so
                  // say so through the sequence's one live region.
                  statusAnnouncement: `Stage 1 of ${steps.length}: ${steps[0]?.label ?? "Creating your run"}. ${steps[0]?.detail ?? ""}`,
                }
              : {})}
            footer={
              failed ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-metadata">
                    The run stopped at stage{" "}
                    {Math.max(1, steps.findIndex((step) => step.state === "failed") + 1)}.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      focusSequenceRef.current = true;
                      startScenario();
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : undefined
            }
          />
        </div>
      </div>
    </RunWorkspaceShell>
  );
}

export function ScenarioRun() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { runId } = useParams({ from: "/app/runs/$runId" });
  const [selectedVmId, setSelectedVmId] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [transportReport, setTransportReport] =
    useState<TerminalTransportReport | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteRunDialogOpen, setDeleteRunDialogOpen] = useState(false);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // The dialogs load lazily on first use and then stay mounted, so their exit
  // plays before they go; unmounting on close would cut it off.
  const [dialogsRequested, setDialogsRequested] = useState({
    cancel: false,
    delete: false,
    ssh: false,
    share: false,
  });
  const openDeleteRunDialog = useCallback(() => {
    setDialogsRequested((current) => ({ ...current, delete: true }));
    setDeleteRunDialogOpen(true);
  }, []);
  const openSshDialog = useCallback(() => {
    setDialogsRequested((current) => ({ ...current, ssh: true }));
    setSshDialogOpen(true);
  }, []);
  // Bumped only by a learner's machine switch, so the startup sequence plays
  // again from a standing start instead of replaying stages that did not
  // just change.
  const [sequenceKey, setSequenceKey] = useState(0);
  const recapHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusRecapAfterShutdownRef = useRef(false);
  const focusedRecapActivityRef = useRef<"background" | "settled" | null>(
    null,
  );
  const runMutationFenceRef = useRef(0);
  const runQueryKey = useMemo(
    () => ["scenarios", "run", runId] as const,
    [runId],
  );
  const runStatusQueryKey = useMemo(
    () => ["scenarios", "run", runId, "status"] as const,
    [runId],
  );
  const beginRunMutation = useCallback(async () => {
    runMutationFenceRef.current += 1;
    await Promise.all([
      queryClient.cancelQueries({ queryKey: runQueryKey, exact: true }),
      queryClient.cancelQueries({ queryKey: runStatusQueryKey, exact: true }),
    ]);
  }, [queryClient, runQueryKey, runStatusQueryKey]);
  const endRunMutation = useCallback(() => {
    runMutationFenceRef.current = Math.max(0, runMutationFenceRef.current - 1);
    if (runMutationFenceRef.current === 0) {
      void queryClient.invalidateQueries({
        queryKey: runStatusQueryKey,
        exact: true,
      });
    }
  }, [queryClient, runStatusQueryKey]);

  const attempt = useQuery({
    queryKey: runQueryKey,
    queryFn: async ({ signal }) => {
      if (runMutationFenceRef.current > 0) {
        const cached = queryClient.getQueryData<ScenarioRunResponse>(runQueryKey);
        if (cached) return cached;
      }
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
        {
          method: "GET",
          credentials: "include",
          signal,
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenario (${response.status})`,
        );
      }

      const body = (await response.json()) as {
        run: Parameters<typeof presentScenarioRun>[0];
      };
      return {
        run: presentScenarioRun(body.run),
      } satisfies ScenarioRunResponse;
    },
    // Keep this complete record as the source of authored content and
    // mutation results. The lightweight status query below owns live updates.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const fetchRunStatus = useCallback(
    async (): Promise<ScenarioRunStatusPollResult> => {
      const cached = queryClient.getQueryData<ScenarioRunResponse>(runQueryKey);
      if (!cached) {
        throw new Error("Scenario status requested before the run loaded");
      }
      const previous = queryClient.getQueryData<ScenarioRunStatusPollResult>(
        runStatusQueryKey,
      );
      const version = previous?.version ?? String(cached.run.updatedAt);
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/status?version=${encodeURIComponent(version)}`,
        {
          method: "GET",
          credentials: "include",
        },
      );
      if (response.status === 204) {
        return preferNewerScenarioStatusResult(
          queryClient.getQueryData<ScenarioRunStatusPollResult>(
            runStatusQueryKey,
          ),
          { status: null, version },
        );
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new HttpResponseError(
          response.status,
          body?.error ?? `Failed to load scenario status (${response.status})`,
        );
      }
      const body = (await response.json()) as { status: ScenarioRunStatus };
      return preferNewerScenarioStatusResult(
        queryClient.getQueryData<ScenarioRunStatusPollResult>(
          runStatusQueryKey,
        ),
        { status: body.status, version: body.status.version },
      );
    },
    [queryClient, runId, runQueryKey, runStatusQueryKey],
  );
  const statusTransport = useMemo(
    () => createScenarioStatusTransport(fetchRunStatus),
    [fetchRunStatus],
  );
  const requestRunStatus = useCallback(
    (fresh = false) => statusTransport.request(fresh),
    [statusTransport],
  );

  // Set while the push stream is subscribed, so polling can fall back to a
  // slow safety-net cadence instead of hammering the status route.
  const statusStreamLiveRef = useRef(false);
  const runStatus = useQuery({
    queryKey: runStatusQueryKey,
    enabled:
      Boolean(attempt.data?.run) &&
      attempt.data?.run.activity !== "settled" &&
      runMutationFenceRef.current === 0,
    queryFn: () => requestRunStatus(),
    refetchInterval: (query) => {
      const record = queryClient.getQueryData<ScenarioRunResponse>(runQueryKey)?.run;
      return scenarioRunStatusRefetchInterval(
        record,
        query.state.error,
        statusStreamLiveRef.current,
      );
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    staleTime: 0,
    retry: retryHttpResponseError,
  });

  const statusRefreshQueue = useMemo(
    () =>
      createScenarioStatusRefreshQueue({
        currentRevision: () =>
          Math.max(
            scenarioStatusRevision(
              queryClient.getQueryData<ScenarioRunStatusPollResult>(
                runStatusQueryKey,
              ),
            ) ?? 0,
            queryClient.getQueryData<ScenarioRunResponse>(runQueryKey)?.run
              .updatedAt ?? 0,
          ),
        refresh: async () => {
          const result = await requestRunStatus(true);
          const revision = scenarioStatusRevision(result);
          queryClient.setQueryData<ScenarioRunStatusPollResult>(
            runStatusQueryKey,
            (current) => {
              return preferNewerScenarioStatusResult(current, result);
            },
          );
          return revision;
        },
      }),
    [queryClient, requestRunStatus, runQueryKey, runStatusQueryKey],
  );
  const requestStatusRefresh = useCallback(
    (revision?: number) => {
      void statusRefreshQueue.request(revision);
    },
    [statusRefreshQueue],
  );

  useEffect(
    () => () => statusRefreshQueue.dispose(),
    [statusRefreshQueue],
  );

  const [pageVisible, setPageVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const updateVisibility = () =>
      setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const shouldSubscribeToStatusStream = Boolean(
    pageVisible &&
      // Lost access refuses every upgrade; don't keep retrying it.
      !isAccessResponseError(runStatus.error, true) &&
      attempt.data?.run &&
      attempt.data.run.activity === "foreground" &&
      attempt.data.run.phase !== "failed" &&
      attempt.data.run.phase !== "completed",
  );
  useEffect(() => {
    if (
      !shouldSubscribeToStatusStream ||
      typeof window === "undefined" ||
      typeof WebSocket === "undefined"
    ) {
      return;
    }

    let disposed = false;
    let websocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1_000;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let awaitingPong = false;

    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      awaitingPong = false;
    };
    // A connection that stops answering may never deliver its close event, so
    // treat it as closed now: poll at the fast cadence and reconnect.
    const abandon = (socket: WebSocket) => {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      try {
        socket.close();
      } catch {
        // The socket is already gone.
      }
      handleClose();
    };
    const handleMessage = (event: MessageEvent) => {
      if (disposed || typeof event.data !== "string") return;
      if (event.data === RUN_STATUS_PONG) {
        awaitingPong = false;
        return;
      }
      const message = parseScenarioRunStatusStreamMessage(event.data, runId);
      if (!message) return;
      if (message.type === "subscribed") {
        reconnectDelay = 1_000;
        statusStreamLiveRef.current = true;
        heartbeat ??= setInterval(() => {
          const socket = websocket;
          if (!socket) return;
          if (awaitingPong) {
            abandon(socket);
            return;
          }
          awaitingPong = true;
          try {
            socket.send(RUN_STATUS_PING);
          } catch {
            abandon(socket);
          }
        }, RUN_STATUS_HEARTBEAT_INTERVAL_MS);
      }
      // A fresh read after subscribing closes any gap since the last poll and
      // re-arms the poll timer at the stream fallback cadence.
      requestStatusRefresh(
        message.type === "invalidate" ? message.revision : undefined,
      );
    };
    const handleClose = () => {
      if (disposed) return;
      stopHeartbeat();
      websocket = null;
      const wasLive = statusStreamLiveRef.current;
      statusStreamLiveRef.current = false;
      // Resume the fast cadence right away rather than after the fallback
      // timer, then try the stream again with backoff. This also renews the
      // socket after its server-side lifetime ends.
      if (wasLive) requestStatusRefresh();
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };
    const connect = () => {
      reconnectTimer = null;
      if (disposed) return;
      try {
        const target = new URL(
          `/api/scenarios/runs/${encodeURIComponent(runId)}/status/stream`,
          window.location.origin,
        );
        target.protocol =
          window.location.protocol === "https:" ? "wss:" : "ws:";
        websocket = new WebSocket(target);
      } catch {
        return;
      }
      websocket.addEventListener("message", handleMessage);
      websocket.addEventListener("close", handleClose);
    };
    connect();

    return () => {
      disposed = true;
      statusStreamLiveRef.current = false;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (!websocket) return;
      websocket.removeEventListener("message", handleMessage);
      websocket.removeEventListener("close", handleClose);
      try {
        websocket.close();
      } catch {
        // Polling remains available if the browser socket is already closed.
      }
    };
  }, [requestStatusRefresh, runId, shouldSubscribeToStatusStream]);

  useEffect(() => {
    const status = runStatus.data?.status;
    if (!status || runMutationFenceRef.current > 0) return;
    queryClient.setQueryData<ScenarioRunResponse>(runQueryKey, (current) => {
      if (!current || runMutationFenceRef.current > 0) return current;
      return { run: mergeScenarioRunStatus(current.run, status) };
    });
  }, [queryClient, runQueryKey, runStatus.data?.status]);

  const completedCourseLocation =
    attempt.data?.run.phase === "completed" &&
    attempt.data.run.activity === "settled"
      ? (attempt.data.run.courseLocation ?? null)
      : null;
  const completedCourseRoute = useMemo(
    () => courseRouteForRun(completedCourseLocation),
    [completedCourseLocation],
  );
  const shouldLoadNextCourseLecture = Boolean(completedCourseRoute);
  // Shares the catalog cache so the course page reuses this fresh copy. It is
  // read once on mount because the finished run just changed lecture state.
  const currentCourse = useQuery({
    queryKey: courseCatalogQueryKey(completedCourseRoute?.organizationId ?? null),
    queryFn: () => fetchCurrentCourseCatalog(completedCourseRoute),
    enabled: shouldLoadNextCourseLecture,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const destroyScenario = useMutation({
    onMutate: beginRunMutation,
    mutationFn: async () => {
      let response: Response;
      try {
        response = await fetch(
          `/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`,
          {
            method: "POST",
            credentials: "include",
          },
        );
      } catch {
        throw new Error(
          "Could not reach the control plane. Check your connection and retry ending the run.",
        );
      }

      const body = (await response.json().catch(() => null)) as
        | ScenarioDestroyAcceptedResponse
        | { error?: string }
        | null;

      if (
        !response.ok ||
        !body ||
        !("accepted" in body) ||
        body.accepted !== true ||
        typeof body.runId !== "string" ||
        !("run" in body) ||
        !body.run
      ) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : "Failed to end run",
        );
      }

      return body;
    },
    onSuccess: (body) => {
      focusRecapAfterShutdownRef.current = true;
      focusedRecapActivityRef.current = null;
      queryClient.setQueryData(["scenarios", "run", runId], {
        run: presentScenarioRun(body.run),
      });
      setCancelDialogOpen(false);
      setTerminalVisible(false);
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "summary"],
      });
    },
    onSettled: endRunMutation,
  });
  const { reset: resetDestroyScenario } = destroyScenario;
  const openCancelDialog = useCallback(() => {
    // A failure from an earlier attempt is not replayed when the dialog opens.
    resetDestroyScenario();
    setDialogsRequested((current) => ({ ...current, cancel: true }));
    setCancelDialogOpen(true);
  }, [resetDestroyScenario]);

  const deleteRun = useMutation({
    mutationFn: async () => {
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
      setDeleteRunDialogOpen(false);
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "summary"],
      });
      if (attemptData?.scenarioId) {
        await navigateToRunCourse(
          navigate,
          attemptData.courseLocation,
          attemptData.organizationId,
        );
        return;
      }

      await navigate({ to: "/courses" });
    },
  });

  const revealHint = useMutation({
    onMutate: beginRunMutation,
    mutationFn: async (hintKey: string) => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/hints/reveal`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hintKey }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        run?: Parameters<typeof presentScenarioRun>[0];
        error?: string;
      } | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "Failed to reveal hint");
      }
      return presentScenarioRun(body.run);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(["scenarios", "run", runId], { run });
    },
    onSettled: endRunMutation,
  });

  const revealSolution = useMutation({
    onMutate: beginRunMutation,
    mutationFn: async () => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/solution/reveal`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const body = (await response.json().catch(() => null)) as {
        run?: Parameters<typeof presentScenarioRun>[0];
        error?: string;
      } | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "Failed to reveal solution");
      }
      return presentScenarioRun(body.run);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(["scenarios", "run", runId], { run });
    },
    onSettled: endRunMutation,
  });

  const shareRun = useMutation({
    onMutate: beginRunMutation,
    mutationFn: async (enabled: boolean) => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/share`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        shareUrl?: string | null;
        error?: string;
      } | null;
      if (!response.ok || !body || !("shareUrl" in body)) {
        throw new Error(
          body?.error ??
            (enabled ? "Failed to share the run" : "Failed to stop sharing"),
        );
      }
      return body.shareUrl ?? null;
    },
    onSuccess: (shareUrl) => {
      // The run view says the same on its next read: sharing again after a
      // stop is offered, and while it is on there is nothing to offer.
      queryClient.setQueryData<ScenarioRunResponse>(runQueryKey, (current) =>
        current
          ? {
              run: {
                ...current.run,
                share: shareUrl === null ? null : { url: shareUrl },
                canShare: shareUrl === null && current.run.active,
              },
            }
          : current,
      );
    },
    onSettled: () => {
      endRunMutation();
      // Only now, with the fence down, does the read reach the server.
      void queryClient.invalidateQueries({
        queryKey: runQueryKey,
        exact: true,
      });
    },
  });
  const { reset: resetShareRun } = shareRun;
  const openShareDialog = useCallback(() => {
    // A failure from an earlier attempt is not replayed when the dialog opens.
    resetShareRun();
    setDialogsRequested((current) => ({ ...current, share: true }));
    setShareDialogOpen(true);
  }, [resetShareRun]);

  const attemptData = attempt.data?.run ?? null;
  const bootEvidence = useMemo(
    () =>
      attemptData
        ? { runId: attemptData.id, scenarioId: attemptData.scenarioId }
        : null,
    [attemptData?.id, attemptData?.scenarioId],
  );
  const nextCourseLecture = useMemo(
    () =>
      attemptData && currentCourse.data
        ? findNextCourseLecture({
            route: completedCourseRoute,
            lectureId: attemptData.courseLocation?.lectureId ?? null,
            scenarioId: attemptData.scenarioId,
            courses: currentCourse.data.courses,
          })
        : null,
    [attemptData, completedCourseRoute, currentCourse.data],
  );
  const selectedVm = useMemo(() => {
    if (!attemptData?.vms.length) {
      return null;
    }

    return (
      attemptData.vms.find((vm) => vm.id === selectedVmId) ??
      attemptData.vms[0] ??
      null
    );
  }, [attemptData, selectedVmId]);
  const selectedVmShellReady = Boolean(
    selectedVm && hasUsableTerminalTarget(selectedVm),
  );

  useEffect(() => {
    if (!bootEvidence || attemptData?.activity !== "foreground") return;
    let current = true;
    void import("@/components/remote-access/WebSshTerminal")
      .then(() => {
        if (current) {
          markScenarioRunBootStage({ ...bootEvidence, stage: "terminal-module" });
        }
      })
      .catch(() => {
        // The terminal lazy boundary reports a module failure when it is shown.
      });
    void loadReplayTerminalFont().then((loaded) => {
      if (current && loaded) {
        markScenarioRunBootStage({ ...bootEvidence, stage: "terminal-font" });
      }
    });
    return () => {
      current = false;
    };
  }, [attemptData?.activity, bootEvidence]);

  // The saving screen lives in the recap chunk; fetch it while the run is
  // live so finishing shows it at once instead of a loading frame.
  useEffect(() => {
    if (attemptData?.activity === "foreground") {
      void import("@/components/app/run/RunRecap").catch(() => {
        // The lazy boundary reports a failed load when the recap is shown.
      });
    }
  }, [attemptData?.activity]);

  useEffect(() => {
    if (bootEvidence && selectedVmShellReady) {
      markScenarioRunBootStage({ ...bootEvidence, stage: "status-ready" });
    }
  }, [bootEvidence, selectedVmShellReady]);

  const showSelectedVmPreparation = Boolean(
    attemptData &&
    !selectedVmShellReady &&
    (!selectedVm ||
      selectedVm.phase === "launching" ||
      selectedVm.phase === "booting" ||
      selectedVm.phase === "waiting_for_target"),
  );
  // A machine that failed before a shell ever opened keeps the startup
  // sequence on screen, with the failed stage stretched and tinted. A shell
  // lost after it was usable keeps the shell status card.
  const vmFailedBeforeShell = Boolean(
    attemptData &&
      selectedVm?.phase === "failed" &&
      !selectedVmShellReady &&
      !terminalVisible,
  );
  const showBootSequence = showSelectedVmPreparation || vmFailedBeforeShell;
  const showBackgroundStatus = attemptData?.activity === "background";
  const acceptanceRetryNeeded = Boolean(
    attemptData?.activity === "foreground" &&
    attemptData.deleteRequestedAt !== null,
  );
  const infrastructureTeardownPending = Boolean(
    attemptData && hasPendingInfrastructureTeardown(attemptData.vms),
  );
  const showCancelAction =
    attemptData !== null &&
    ((attemptData.activity === "foreground" &&
      (attemptData.canDestroy || acceptanceRetryNeeded) &&
      attemptData.phase !== "solved") ||
      (attemptData.activity === "settled" &&
        attemptData.phase === "failed" &&
        infrastructureTeardownPending));
  const showFinishBar =
    attemptData !== null &&
    attemptData.phase === "solved" &&
    attemptData.activity === "foreground";
  // The Moment Rule: only a run that turns solved while this page is open
  // plays the completion; one that loads solved shows it still.
  const justSolved = useJustReached(
    attemptData ? [["run", attemptData.phase] as const] : [],
    "solved",
  ).has("run");
  // The recap arrives live only when this page watched the run finish.
  const sawForeground = useRef(false);
  if (attemptData?.activity === "foreground") sawForeground.current = true;
  const leaseDeadlineMs =
    attemptData !== null && attemptData.outcome === "in_progress"
      ? computeLeaseDeadline(
          attemptData.createdAt,
          attemptData.vms.map((vm) => vm.provisioning?.leaseDurationSeconds),
        )
      : null;
  const selectedProbes = selectedVm?.scenarioProbes ?? [];
  // Sharing is offered to a run that is active, and a shared run can always be
  // stopped, even after it has finished. Only the run view answers whether it
  // may be offered; a record from a hint or the start does not. The last
  // answer stands, and the run view is asked once if there never was one.
  const shareLink = attemptData?.share?.url ?? null;
  const shareOffer = useRef<boolean | null>(null);
  if (attemptData?.canShare !== undefined) {
    shareOffer.current = attemptData.canShare;
  }
  const showShareAction = Boolean(
    attemptData &&
      (attemptData.share != null ||
        (shareOffer.current === true && attemptData.active)),
  );
  const askedShareOffer = useRef<string | null>(null);
  useEffect(() => {
    if (!attemptData || shareOffer.current !== null) return;
    if (askedShareOffer.current === attemptData.id) return;
    askedShareOffer.current = attemptData.id;
    void queryClient.invalidateQueries({ queryKey: runQueryKey, exact: true });
  }, [attemptData?.id, attemptData?.canShare, queryClient, runQueryKey]);
  const canDeleteRun =
    attemptData !== null &&
    (attemptData.phase === "completed" || attemptData.phase === "failed") &&
    attemptData.activity === "settled" &&
    !infrastructureTeardownPending;
  const bootSteps = useMemo(
    () => buildScenarioBootSteps(attemptData, selectedVm),
    [attemptData, selectedVm],
  );
  const bootScreenCopy = useMemo(
    () => getScenarioBootScreenCopy(attemptData),
    [attemptData],
  );
  const selectedVmSessionRequest = useMemo(
    () =>
      selectedVm
        ? {
            url: `/api/scenarios/runs/${encodeURIComponent(attemptData?.id ?? runId)}/ssh`,
            body: { vmId: selectedVm.id },
          }
        : null,
    [attemptData?.id, runId, selectedVm],
  );
  // The gateway `ready` frame is the transport truth and the projection is a
  // poll, so the reveal follows the transport. The projection keeps the
  // existing manual path working.
  const transportReady = isTransportReadyFor(
    transportReport,
    selectedVm?.id ?? null,
  );
  const showTerminal = shouldRevealTerminal({
    transportReady,
    projectedReady: selectedVmShellReady,
    userWantsTerminal: terminalVisible,
    runForeground: attemptData?.activity === "foreground",
  });
  // The transport starts while the VM boots, hidden. It connects and waits for
  // its target, and reports readiness so the shell can be revealed at once.
  const terminalTransportMounted = Boolean(
    selectedVm &&
      selectedVmSessionRequest &&
      attemptData?.activity === "foreground",
  );
  // The shell arrives with a rise only when it becomes ready while the page
  // is open; reloading a run whose shell is ready shows it still.
  const terminalJustRevealed = useJustReached(
    selectedVm
      ? [[selectedVm.id, showTerminal ? "shown" : "hidden"] as const]
      : [],
    "shown",
  ).has(selectedVm?.id ?? "");

  useEffect(() => {
    if (transportReady || selectedVmShellReady) {
      setTerminalVisible(true);
    }
  }, [selectedVmShellReady, transportReady]);

  useEffect(() => {
    if (
      !focusRecapAfterShutdownRef.current ||
      !attemptData ||
      attemptData.activity === "foreground"
    ) {
      return;
    }

    if (focusedRecapActivityRef.current === attemptData.activity) {
      return;
    }
    focusedRecapActivityRef.current = attemptData.activity;
    let frame = 0;
    let remainingFrames = 60;
    const focusWhenMounted = () => {
      const heading = recapHeadingRef.current;
      if (heading) {
        heading.focus({ preventScroll: true });
        if (attemptData.activity === "settled") {
          focusRecapAfterShutdownRef.current = false;
        }
        return;
      }
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        frame = window.requestAnimationFrame(focusWhenMounted);
      }
    };
    frame = window.requestAnimationFrame(focusWhenMounted);
    return () => window.cancelAnimationFrame(frame);
  }, [attemptData?.activity]);

  useEffect(() => {
    if (!attemptData?.vms.length) {
      setSelectedVmId(null);
      return;
    }

    setSelectedVmId((current) => {
      const readyVmId =
        attemptData.vms.find((vm) => hasUsableTerminalTarget(vm))?.id ?? null;
      if (current && attemptData.vms.some((vm) => vm.id === current)) {
        if (!terminalVisible && readyVmId) {
          const currentVm = attemptData.vms.find((vm) => vm.id === current);
          if (currentVm && !hasUsableTerminalTarget(currentVm)) {
            return readyVmId;
          }
        }
        return current;
      }
      return readyVmId ?? attemptData.vms[0]?.id ?? null;
    });
  }, [attemptData?.vms, terminalVisible]);

  const requestDestroyScenario = useCallback(() => {
    destroyScenario.reset();
    destroyScenario.mutate();
  }, [destroyScenario]);

  const showEndRunAction =
    showCancelAction &&
    (acceptanceRetryNeeded ||
      attemptData?.outcome === "in_progress" ||
      infrastructureTeardownPending) &&
    !showBackgroundStatus;
  const showSshAction = Boolean(
    selectedVm &&
    selectedVmSessionRequest &&
    attemptData?.outcome === "in_progress" &&
    attemptData.activity === "foreground",
  );
  const runStatusDisplay = useMemo(() => {
    if (!attemptData) return undefined;
    const plan = planActiveRunStatus({
      activity: attemptData.activity,
      outcome: attemptData.outcome,
      phase: attemptData.phase,
      phaseTitle: attemptData.phaseTitle,
      preparing: showSelectedVmPreparation,
      vmPhaseTitle: selectedVm?.phaseTitle ?? null,
    });
    if (plan) {
      return (
        <ActiveRunStatus
          tone={plan.tone}
          word={plan.word}
          startedAt={attemptData.createdAt}
          leaseDeadlineMs={leaseDeadlineMs}
          // Saving is already closing the sandbox, so a phone's slim run bar
          // keeps its room for the saving sequence.
          leaseHiddenOnPhone={attemptData.activity === "background"}
          frozenMs={plan.frozen ? attemptData.solveDurationMs : null}
          pulse={plan.pulse}
        />
      );
    }
    switch (attemptData.outcome) {
      case "succeeded":
        // The solve time stays beside the word once the page leaves the shell.
        return (
          <StatusToken
            tone="success"
            word="Solved"
            elapsed={
              attemptData.solveDurationMs != null
                ? formatClockSeconds(Math.floor(attemptData.solveDurationMs / 1000))
                : null
            }
          />
        );
      case "failed":
        return <StatusToken tone="danger" word="Failed" />;
      default:
        return <StatusToken tone="muted" word="Ended early" />;
    }
  }, [
    attemptData,
    leaseDeadlineMs,
    selectedVm?.phaseTitle,
    showSelectedVmPreparation,
  ]);
  // While the run is shared the header says so, wherever the status shows.
  const runShared = attemptData?.share != null;
  const runStatusNode = useMemo(
    () =>
      runShared && runStatusDisplay ? (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {runStatusDisplay}
          <SharedBadge />
        </span>
      ) : (
        runStatusDisplay
      ),
    [runShared, runStatusDisplay],
  );

  const runIsLive = attemptData?.activity === "foreground";
  const runUsesFocusedShell =
    attemptData?.activity === "foreground" ||
    attemptData?.activity === "background";
  const runAction = useMemo(
    () =>
      showEndRunAction ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="hidden sm:inline-flex"
          aria-haspopup="dialog"
          aria-expanded={cancelDialogOpen}
          onClick={openCancelDialog}
        >
          <BinIcon />
          End run…
        </Button>
      ) : canDeleteRun ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="hidden sm:inline-flex"
          aria-haspopup="dialog"
          aria-expanded={deleteRunDialogOpen}
          onClick={openDeleteRunDialog}
        >
          <BinIcon />
          Delete run…
        </Button>
      ) : undefined,
    [
      canDeleteRun,
      cancelDialogOpen,
      deleteRunDialogOpen,
      openCancelDialog,
      openDeleteRunDialog,
      showEndRunAction,
    ],
  );
  const runMenu = useMemo(
    () =>
      showEndRunAction ? (
        <DropdownMenuItem
          variant="destructive"
          className="sm:hidden"
          aria-haspopup="dialog"
          onClick={openCancelDialog}
        >
          End run…
        </DropdownMenuItem>
      ) : canDeleteRun ? (
        <DropdownMenuItem
          variant="destructive"
          className="sm:hidden"
          aria-haspopup="dialog"
          onClick={openDeleteRunDialog}
        >
          Delete run…
        </DropdownMenuItem>
      ) : undefined,
    [canDeleteRun, openCancelDialog, openDeleteRunDialog, showEndRunAction],
  );
  // Share sits beside the run's own action in the app bar, and in its menu on
  // a phone, while it is offered or the run is shared.
  const shareAction = useMemo(
    () =>
      showShareAction ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="hidden sm:inline-flex"
          aria-haspopup="dialog"
          aria-expanded={shareDialogOpen}
          onClick={openShareDialog}
        >
          <Share2 aria-hidden="true" />
          Share
        </Button>
      ) : null,
    [openShareDialog, shareDialogOpen, showShareAction],
  );
  const shareMenuItem = useMemo(
    () =>
      showShareAction ? (
        <DropdownMenuItem
          className="sm:hidden"
          aria-haspopup="dialog"
          onClick={openShareDialog}
        >
          Share
        </DropdownMenuItem>
      ) : null,
    [openShareDialog, showShareAction],
  );
  const pageAction = useMemo(
    () =>
      shareAction ? (
        <>
          {shareAction}
          {runAction}
        </>
      ) : (
        runAction
      ),
    [runAction, shareAction],
  );
  const pageMenu = useMemo(
    () =>
      shareMenuItem ? (
        <>
          {shareMenuItem}
          {runMenu}
        </>
      ) : (
        runMenu
      ),
    [runMenu, shareMenuItem],
  );
  const runBackTarget = attemptData
    ? getRunReturnTarget(attemptData.courseLocation)
    : null;
  const runBackNavigation = useMemo(() => {
    if (runUsesFocusedShell || !runBackTarget) return undefined;
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        render={
          <a
            href={runBackTarget.href}
            aria-label={runBackTarget.label}
            data-run-back
          />
        }
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        <span className="hidden md:inline">{runBackTarget.text}</span>
      </Button>
    );
  }, [
    runBackTarget?.href,
    runBackTarget?.label,
    runBackTarget?.text,
    runUsesFocusedShell,
  ]);
  usePageChrome({
    title: attemptData?.title ?? "Scenario run",
    status: runUsesFocusedShell ? undefined : runStatusNode,
    back: runBackNavigation,
    action: runUsesFocusedShell ? undefined : pageAction,
    menu: runUsesFocusedShell ? undefined : pageMenu,
    fullscreen: runUsesFocusedShell,
  });

  const runActions =
    showSshAction || showShareAction || showEndRunAction || canDeleteRun ? (
      <RunActions
        ssh={
          showSshAction
            ? {
                disabled: !selectedVmShellReady,
                expanded: sshDialogOpen,
                onOpen: openSshDialog,
              }
            : null
        }
        share={
          showShareAction
            ? { expanded: shareDialogOpen, onOpen: openShareDialog }
            : null
        }
        end={
          showEndRunAction
            ? {
                label: acceptanceRetryNeeded ? "Retry end…" : "End run…",
                expanded: cancelDialogOpen,
                onOpen: openCancelDialog,
              }
            : null
        }
        remove={
          canDeleteRun
            ? { expanded: deleteRunDialogOpen, onOpen: openDeleteRunDialog }
            : null
        }
      />
    ) : null;

  // The browser tab carries live-run state while the user is elsewhere.
  const scenarioName = attemptData?.title ?? null;
  useEffect(() => {
    if (!runIsLive || !scenarioName) return;
    const previous = document.title;
    // A word, not a bare glyph: status is a word first.
    const live = `In progress · ${scenarioName} · intar.dev`;
    document.title = live;
    return () => {
      // On route changes HeadContent has already committed the destination
      // title before this cleanup runs — only restore what we still own.
      if (document.title === live) {
        document.title = previous;
      }
    };
  }, [runIsLive, scenarioName]);

  const runDialogs = (
    <>
      {dialogsRequested.cancel ? (
        <Suspense fallback={null}>
          <LazyScenarioCancelDialog
            trigger={false}
            open={cancelDialogOpen}
            onOpenChange={setCancelDialogOpen}
            onConfirm={requestDestroyScenario}
            pending={destroyScenario.isPending}
            retry={acceptanceRetryNeeded}
            error={
              destroyScenario.error
                ? "The run could not be ended. Your work is still open."
                : null
            }
          />
        </Suspense>
      ) : null}
      {dialogsRequested.delete ? (
        <Suspense fallback={null}>
          <LazyDeleteRunDialog
            trigger={false}
            open={deleteRunDialogOpen}
            onOpenChange={(open) => {
              setDeleteRunDialogOpen(open);
              if (!open) deleteRun.reset();
            }}
            onConfirm={() => deleteRun.mutate()}
            pending={deleteRun.isPending}
            error={Boolean(deleteRun.error)}
          />
        </Suspense>
      ) : null}
      {selectedVm && selectedVmSessionRequest && dialogsRequested.ssh ? (
        <Suspense fallback={null}>
          <LazyNativeSshSheet
            vmName={selectedVm.scenarioVmName}
            sessionRequest={selectedVmSessionRequest}
            open={sshDialogOpen}
            onOpenChange={setSshDialogOpen}
          />
        </Suspense>
      ) : null}
      {dialogsRequested.share ? (
        <Suspense fallback={null}>
          <LazyRunShareDialog
            open={shareDialogOpen}
            onOpenChange={(open) => {
              setShareDialogOpen(open);
              if (!open) resetShareRun();
            }}
            url={shareLink}
            pending={shareRun.isPending}
            error={
              shareRun.error
                ? shareRun.error instanceof Error
                  ? shareRun.error.message
                  : "Try again in a moment."
                : null
            }
            onShare={() => shareRun.mutate(true)}
            onStop={() => shareRun.mutate(false)}
          />
        </Suspense>
      ) : null}
    </>
  );

  const errorAlerts = (
    <>
      {/* With nothing cached the error takes the content's place below. This
          is the stale-data case: the run is on screen and a refresh failed. */}
      {attempt.error && attemptData ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load this run</AlertTitle>
          <AlertDescription>
            The latest changes did not load. Try again in a moment.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* The dialog already raised and announced this failure; what is left
          here is a still reminder, so it is not marked `just`. */}
      {destroyScenario.error && !cancelDialogOpen && !showFinishBar ? (
        <Alert variant="destructive">
          <AlertTitle>Could not end run</AlertTitle>
          <AlertDescription>
            Your work is still open. Try ending the run again.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  if (!attemptData) {
    return (
      <PageShell>
        {runDialogs}
        {errorAlerts}
        {attempt.error ? (
          <ErrorState
            title="Could not load this run"
            description="Check your connection and try again."
            onRetry={() => attempt.refetch()}
          />
        ) : null}
        {!attempt.error ? (
          <p
            className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"
            role="status"
          >
            Loading your run…
          </p>
        ) : null}
      </PageShell>
    );
  }

  const guidanceProps: RunLearningPanelProps = {
    briefingMarkdown: attemptData.briefingMarkdown,
    lectureMarkdown: attemptData.lectureBodyMarkdown ?? null,
    lectureTitle: attemptData.lectureTitle ?? null,
    phase: attemptData.phase,
    // Solved stays solved through saving, archiving and deleting, so the
    // check circuit stays closed.
    runSolved: attemptData.phase === "solved" || attemptData.solvedAt !== null,
    probes: selectedProbes,
    vmName: selectedVm?.scenarioVmName ?? null,
    objectives: attemptData.objectives,
    hints: attemptData.hints,
    solution: attemptData.solution,
    onRevealHint: (hintKey: string) => revealHint.mutate(hintKey),
    pendingHintKey: revealHint.isPending
      ? (revealHint.variables ?? null)
      : null,
    hintError:
      revealHint.error instanceof Error ? revealHint.error.message : null,
    failedHintKey: revealHint.error ? (revealHint.variables ?? null) : null,
    onRevealSolution: () => revealSolution.mutate(),
    solutionPending: revealSolution.isPending,
    solutionError:
      revealSolution.error instanceof Error
        ? revealSolution.error.message
        : null,
  };

  const runRecap = (
    <Suspense
      // Neutral and silent: the saving sequence is what the learner reads, and
      // the chunk is preloaded while the run is live, so this rarely shows.
      fallback={
        <div
          aria-hidden="true"
          className="mx-auto w-full max-w-[36rem] flex-1 py-8"
        >
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      }
    >
      <LazyRunRecap
        run={attemptData}
        courseLocation={attemptData.courseLocation}
        nextLecture={nextCourseLecture}
        headingRef={recapHeadingRef}
        animate={sawForeground.current}
      />
    </Suspense>
  );

  if (attemptData.activity === "background") {
    return (
      <RunWorkspaceShell
        before={runDialogs}
        title={attemptData.title}
        status={runStatusNode}
        actions={runActions}
        returnTarget={getRunReturnTarget(attemptData.courseLocation)}
        guidance={guidanceProps}
      >
        <div
          data-run-shutdown-sequence
          role="region"
          aria-label="Run saving progress"
          tabIndex={0}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4"
        >
          <div className="shrink-0 space-y-2 empty:hidden">{errorAlerts}</div>
          {runRecap}
        </div>
      </RunWorkspaceShell>
    );
  }

  if (attemptData.activity !== "foreground") {
    return (
      <PageShell>
        {runDialogs}
        {errorAlerts}
        {runRecap}
      </PageShell>
    );
  }

  // A live run owns the viewport: runtime on the left, learning reference on
  // the right, and no page-level scroll around either surface.
  return (
    <RunWorkspaceShell
      before={runDialogs}
      title={attemptData.title}
      status={runStatusNode}
      actions={runActions}
      returnTarget={getRunReturnTarget(attemptData.courseLocation)}
      guidance={guidanceProps}
      solvedBeat={justSolved}
      completion={
        showFinishBar ? (
          <RunCompletionBar
            canFinish={attemptData.canDestroy}
            pending={destroyScenario.isPending}
            error={Boolean(destroyScenario.error)}
            onFinish={requestDestroyScenario}
          />
        ) : null
      }
    >
      <RunWorkArea>
            <div className="shrink-0 space-y-2 empty:hidden">
              {errorAlerts}
            </div>

            {showFinishBar ? (
              <RunCompletionSlot animate={justSolved}>
                {(animate) => (
                  <RunCompletionBar
                    canFinish={attemptData.canDestroy}
                    pending={destroyScenario.isPending}
                    error={Boolean(destroyScenario.error)}
                    onFinish={requestDestroyScenario}
                    animate={animate}
                  />
                )}
              </RunCompletionSlot>
            ) : null}

            <section
              // While the startup sequence shows there is no terminal to
              // name, and the sequence names itself. The machine is named
              // here: the embedded terminal has no header chip any more.
              aria-label={
                showTerminal
                  ? selectedVm
                    ? `${selectedVm.scenarioVmName} terminal`
                    : "Terminal"
                  : undefined
              }
              className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2"
            >
              <ScenarioVmSelector
                vms={attemptData.vms}
                selectedVmId={selectedVmId}
                onSelect={(vmId) => {
                  setSelectedVmId(vmId);
                  setSequenceKey((key) => key + 1);
                }}
              />

              {/* One transport instance for the whole run. It starts during VM
                  boot and stays mounted across the ready transition, so the
                  WebSocket is already waiting for the target and no second
                  session is opened when the shell becomes visible. */}
              {selectedVm && terminalTransportMounted ? (
                <div
                  {...(showTerminal ? { "data-scenario-terminal-ready": true } : {})}
                  aria-hidden={showTerminal ? undefined : true}
                  className={cn(
                    "relative min-h-0 min-w-0 flex-1",
                    showTerminal
                      ? terminalJustRevealed &&
                          "animate-in fade-in-0 slide-in-from-bottom-[length:var(--move-swap)] duration-(--duration-moderate) ease-enter"
                      : "hidden",
                  )}
                >
                  <Suspense
                    fallback={
                      showTerminal ? (
                        <div
                          className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground"
                          role="status"
                        >
                          Opening secure shell…
                        </div>
                      ) : null
                    }
                  >
                    <RunTerminal
                      vmName={selectedVm.scenarioVmName}
                      sessionRequest={selectedVmSessionRequest!}
                      variant="embedded"
                      title={`${selectedVm.scenarioVmName} shell`}
                      showCloseButton={false}
                      onClose={() => setTerminalVisible(false)}
                      bootEvidence={bootEvidence}
                      visible={showTerminal}
                      onTransportStateChange={(state) =>
                        setTransportReport({
                          vmId: selectedVm.id,
                          attempt: state.attempt,
                          ready: state.ready,
                        })
                      }
                    />
                  </Suspense>
                </div>
              ) : null}

              {showTerminal ? null : (
                <div
                  aria-label={
                    showBootSequence ? "Workspace startup progress" : undefined
                  }
                  className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
                  role={showBootSequence ? "region" : undefined}
                  tabIndex={showBootSequence ? 0 : undefined}
                >
                  {showBootSequence ? (
                    <div
                      className="m-auto w-full py-4 transition-transform duration-(--duration-moderate) ease-enter motion-reduce:transition-none sm:px-1 sm:py-6"
                      data-run-sequence-frame
                    >
                      <ScenarioStepScreen
                        key={sequenceKey}
                        title={bootScreenCopy.title}
                        description={bootScreenCopy.description}
                        steps={bootSteps}
                        listLabel="Startup steps"
                        handoffFrom={`run-start:${attemptData.scenarioId}`}
                        footer={
                          vmFailedBeforeShell ? (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <p className="text-metadata">
                                The run stopped at stage{" "}
                                {Math.max(
                                  1,
                                  bootSteps.findIndex(
                                    (step) => step.state === "failed",
                                  ) + 1,
                                )}
                                .
                              </p>
                              {showEndRunAction ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-haspopup="dialog"
                                  aria-expanded={cancelDialogOpen}
                                  onClick={openCancelDialog}
                                >
                                  End this run
                                </Button>
                              ) : null}
                            </div>
                          ) : undefined
                        }
                      />
                    </div>
                  ) : (
                    <ScenarioShellStatusCard
                      phase={selectedVm?.phase ?? attemptData.phase}
                      title={selectedVm?.phaseTitle ?? attemptData.phaseTitle}
                      pending={
                        !selectedVmShellReady &&
                        Boolean(selectedVm && selectedVm.phase !== "failed")
                      }
                    />
                  )}
                </div>
              )}
            </section>
      </RunWorkArea>
    </RunWorkspaceShell>
  );
}

function RunWorkspaceShell({
  before,
  title,
  status,
  actions,
  returnTarget,
  guidance,
  solvedBeat = false,
  completion = null,
  children,
}: {
  before?: ReactNode;
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  returnTarget: { href: string; label: string; text: string };
  guidance: RunLearningPanelProps;
  /** The run turned solved while this page was open. */
  solvedBeat?: boolean;
  /** The finish block, shown in the phone sheet while it is open. */
  completion?: ReactNode;
  children: ReactNode;
}) {
  return (
    <RunPageFrame>
      <RunWorkspaceBody
        before={before}
        title={title}
        status={status}
        actions={actions}
        returnTarget={returnTarget}
        guidance={guidance}
        solvedBeat={solvedBeat}
        completion={completion}
      >
        {children}
      </RunWorkspaceBody>
    </RunPageFrame>
  );
}

// The frame follows visualViewport.height while the on-screen keyboard is up,
// so the prompt never sits under it, and it carries the lifted sheet state
// that the dock, the landscape bar buttons and the completion beat share.
function RunPageFrame({ children }: { children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const keyboardUp = useRunKeyboard(frameRef);
  const frame = useMemo(() => ({ keyboardUp }), [keyboardUp]);
  const sheet = useRunSheetController();

  return (
    <RunFrameProvider value={frame}>
      <RunSheetProvider value={sheet}>
        <div
          ref={frameRef}
          data-run-page
          data-kb={keyboardUp ? "" : undefined}
          // Safe areas are padded once, here; the dock and the sheets carry
          // the bottom inset themselves.
          className="group/run relative flex h-[var(--run-vh,100dvh)] max-h-[var(--run-vh,100dvh)] min-h-0 min-w-0 flex-col overflow-hidden bg-canvas pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] [--run-bar-h:3rem] dock:[--run-bar-h:3.25rem] short:[--run-bar-h:2.5rem]"
        >
          {children}
        </div>
      </RunSheetProvider>
    </RunFrameProvider>
  );
}

function RunWorkspaceBody({
  before,
  title,
  status,
  actions,
  returnTarget,
  guidance,
  solvedBeat,
  completion,
  children,
}: {
  before?: ReactNode;
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  returnTarget: { href: string; label: string; text: string };
  guidance: RunLearningPanelProps;
  solvedBeat: boolean;
  completion: ReactNode;
  children: ReactNode;
}) {
  const { keyboardUp } = useRunFrame();
  const sheet = useRunSheet();
  const docked = useMediaQuery(RUN_QUERY.docked);
  const split = useMediaQuery(RUN_QUERY.split);
  // Reading and typing take turns on a phone: raising the keyboard lowers the
  // sheet. On a tablet the panel folds away instead, so the terminal keeps
  // the room; a hardware keyboard never raises either.
  const folded = keyboardUp && docked && !split;
  const closeSheet = sheet?.closeSheet;
  useEffect(() => {
    if (keyboardUp) closeSheet?.();
  }, [keyboardUp, closeSheet]);

  // When the last check verifies the circuit closes, then (650ms in) the
  // keyboard lowers and, on a phone, the sheet rises to peek on the finish
  // block. A run that loads solved does nothing.
  const openSheet = sheet?.openSheet;
  useEffect(() => {
    if (!solvedBeat) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[data-run-terminal]")) {
        active.blur();
      }
      if (!window.matchMedia(RUN_QUERY.docked).matches) {
        openSheet?.("checks", { detent: "peek", opener: null });
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [solvedBeat, openSheet]);

  return (
    <>
      {before}
      {/* The run bar and check bar span the full width above the split. */}
      <div className="relative shrink-0">
        <RunWorkspaceHeader
          title={title}
          status={status}
          actions={actions}
          returnTarget={returnTarget}
        />
        <RunCheckBar {...guidance} className="mx-4 mb-2 dock:hidden" />
        <RunCheckToast
          probes={guidance.probes}
          objectives={guidance.objectives}
          vmName={guidance.vmName ?? null}
          active={!docked && !(sheet?.open ?? false)}
        />
      </div>
      <div
        data-run-workspace
        className={cn(
          "grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden split:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] split:grid-rows-[minmax(0,1fr)]",
          folded
            ? "dock:grid-rows-[minmax(0,1fr)_0]"
            : "dock:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]",
        )}
      >
        <div
          data-run-work-area
          className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-canvas"
        >
          {children}
        </div>
        <RunLearningPanel
          {...guidance}
          {...(folded ? { className: "invisible" } : {})}
        />
      </div>
      <RunLearningPanelMobile {...guidance} completion={completion} />
    </>
  );
}

// The terminal box sits 0.5rem from the screen sides on phones and takes the
// main area's 0.75rem from bp-md. A landscape phone carries the bottom safe
// area itself, since it has no dock.
function RunWorkArea({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 pt-1 pb-2 md:px-3 md:pb-3 short:pb-[max(0.5rem,env(safe-area-inset-bottom))] group-data-[kb]/run:short:pb-2">
      {children}
    </div>
  );
}

// On a phone the finish block moves into the sheet while it is open, so the
// two never stand side by side as twin buttons. The bar's rise is a moment
// that plays once: when the sheet takes the bar away the moment is spent, and
// the bar comes back still.
function RunCompletionSlot({
  animate,
  children,
}: {
  animate: boolean;
  children: (animate: boolean) => ReactNode;
}) {
  const sheet = useRunSheet();
  const docked = useMediaQuery(RUN_QUERY.docked);
  const away = !docked && (sheet?.open ?? false);
  const [spent, setSpent] = useState(false);
  useEffect(() => {
    if (away) setSpent(true);
  }, [away]);
  return away ? null : <>{children(animate && !spent)}</>;
}

// The key row rides on the on-screen keyboard: phones and tablets only, and
// only while the terminal holds focus with the keyboard up.
function RunTerminal(props: ComponentProps<typeof LazyWebSshTerminal>) {
  const { keyboardUp } = useRunFrame();
  const split = useMediaQuery(RUN_QUERY.split);
  return <LazyWebSshTerminal {...props} keyRow={keyboardUp && !split} />;
}

interface RunActionHandle {
  expanded: boolean;
  onOpen: () => void;
}

// The run's own actions. Beside the title they are text buttons; on a phone
// they shrink to icon buttons that keep their words for assistive technology,
// and in landscape, where the slim bar has no room, or with more than two on
// a phone, they fold into one menu.
function RunActions({
  ssh,
  share,
  end,
  remove,
}: {
  ssh: (RunActionHandle & { disabled: boolean }) | null;
  share: RunActionHandle | null;
  end: (RunActionHandle & { label: string }) | null;
  remove: RunActionHandle | null;
}) {
  const short = useMediaQuery(RUN_QUERY.short);
  const phone = useMediaQuery(RUN_QUERY.phone);
  // A phone has room for two icon buttons beside the title; a third would
  // cover the status line, so three fold into the menu as well.
  const crowded =
    phone && [ssh, share, end, remove].filter(Boolean).length > 2;
  if (short || crowded) {
    return (
      <div role="group" aria-label="Run actions" data-run-actions>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="More run actions"
                    />
                  }
                />
              }
            >
              <EllipsisVertical aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent side="bottom">More run actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {ssh ? (
              <DropdownMenuItem
                disabled={ssh.disabled}
                aria-haspopup="dialog"
                className="pointer-coarse:min-h-11"
                onClick={ssh.onOpen}
              >
                SSH command
              </DropdownMenuItem>
            ) : null}
            {share ? (
              <DropdownMenuItem
                aria-haspopup="dialog"
                className="pointer-coarse:min-h-11"
                onClick={share.onOpen}
              >
                Share
              </DropdownMenuItem>
            ) : null}
            {end ? (
              <DropdownMenuItem
                variant="destructive"
                aria-haspopup="dialog"
                className="pointer-coarse:min-h-11"
                onClick={end.onOpen}
              >
                {end.label}
              </DropdownMenuItem>
            ) : null}
            {remove ? (
              <DropdownMenuItem
                variant="destructive"
                aria-haspopup="dialog"
                className="pointer-coarse:min-h-11"
                onClick={remove.onOpen}
              >
                Delete run…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
  const iconOnPhone = "max-md:min-w-11 max-md:px-0";
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Run actions"
      data-run-actions
    >
      {ssh ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={iconOnPhone}
          disabled={ssh.disabled}
          aria-haspopup="dialog"
          aria-expanded={ssh.expanded}
          onClick={ssh.onOpen}
        >
          <SquareTerminal className="size-4 md:hidden" aria-hidden="true" />
          <span className="max-md:sr-only">SSH command</span>
        </Button>
      ) : null}
      {share ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={iconOnPhone}
          aria-haspopup="dialog"
          aria-expanded={share.expanded}
          onClick={share.onOpen}
        >
          <Share2 className="size-4" aria-hidden="true" />
          <span className="max-md:sr-only">Share</span>
        </Button>
      ) : null}
      {end ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className={iconOnPhone}
          aria-haspopup="dialog"
          aria-expanded={end.expanded}
          onClick={end.onOpen}
        >
          <BinIcon />
          <span className="max-md:sr-only">{end.label}</span>
        </Button>
      ) : null}
      {remove ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className={iconOnPhone}
          aria-haspopup="dialog"
          aria-expanded={remove.expanded}
          onClick={remove.onOpen}
        >
          <BinIcon />
          <span className="max-md:sr-only">Delete run…</span>
        </Button>
      ) : null}
    </div>
  );
}

function RunWorkspaceHeader({
  title,
  status,
  actions,
  returnTarget,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  returnTarget: { href: string; label: string; text: string };
}) {
  const sheet = useRunSheet();
  const short = useMediaQuery(RUN_QUERY.short);
  const opens = (section: "checks" | "lecture") =>
    sheet?.open && sheet.section === section;

  return (
    <header
      // On a phone a grid: back beside the title with its status line under
      // it, and the run actions (icon buttons) in the third column, so they
      // never wrap to a row of their own (below 21.5rem the status takes the
      // row under both). They give way to the keyboard. From md it is one
      // wrapping row. In landscape the bar is 2.5rem, one nowrap row, and
      // hides while the keyboard is up; the check bar stays.
      className="flex min-h-(--run-bar-h) shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-canvas px-2 pt-2 pb-1 md:px-3 max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-y-0 short:flex short:flex-nowrap short:py-0 short:group-data-[kb]/run:hidden"
      data-run-navigation
      data-run-workspace-header
    >
      {/* Keep this a document navigation. Leaving the document guarantees that
          the terminal transport is released before the lecture loads. */}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 shrink-0 max-md:row-span-2 max-[21.5rem]:row-span-1"
        render={
          <a
            href={returnTarget.href}
            aria-label={returnTarget.label}
            data-run-back
          />
        }
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        <span className="max-md:sr-only">{returnTarget.text}</span>
      </Button>
      {/* A title wraps; the bar never cuts it off. */}
      <h1 className="min-w-0 flex-1 text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em] max-md:col-start-2 max-md:row-start-1 md:min-w-[min(16rem,100%)] short:truncate">
        {title}
      </h1>
      {status ? (
        <div className="min-w-0 shrink-0 max-md:col-start-2 max-md:row-start-2 max-md:shrink max-[21.5rem]:col-end-4">
          {status}
        </div>
      ) : null}
      {short && sheet ? (
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Checks"
                  aria-haspopup="dialog"
                  aria-expanded={opens("checks")}
                  data-run-learning-panel-trigger
                  onClick={(event) =>
                    sheet.openSheet("checks", { opener: event.currentTarget })
                  }
                >
                  <ListChecks aria-hidden="true" />
                </Button>
              }
            />
            <TooltipContent side="bottom">Checks</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Lecture and hints"
                  aria-haspopup="dialog"
                  aria-expanded={opens("lecture")}
                  onClick={(event) =>
                    sheet.openSheet("lecture", { opener: event.currentTarget })
                  }
                >
                  <BookOpen aria-hidden="true" />
                </Button>
              }
            />
            <TooltipContent side="bottom">Lecture and hints</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {actions ? (
        <div className="max-md:col-start-3 max-md:row-span-2 max-md:row-start-1 max-md:group-data-[kb]/run:hidden max-[21.5rem]:row-end-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

interface ScenarioRunStartLocation {
  scope: string | undefined;
  organizationId: string | undefined;
  courseId: string | undefined;
  lectureId: string | undefined;
}

function findStartLectureTitle(
  catalog: CourseCatalogResponse | undefined,
  location: ScenarioRunStartLocation,
): string | null {
  if (!catalog || !location.courseId || !location.lectureId) return null;
  const course = catalog.courses.find((candidate) => {
    if (candidate.courseId !== location.courseId) return false;
    return location.scope === "organization-private"
      ? candidate.organizationId === location.organizationId
      : candidate.organizationId === null;
  });
  return (
    course?.lectures.find(
      (lecture) => lecture.lectureId === location.lectureId,
    )?.title ?? null
  );
}

function getStartReturnTarget(
  location: ScenarioRunStartLocation,
): { href: string; label: string; text: string } {
  if (!location.scope || !location.courseId || !location.lectureId) {
    return { href: "/courses", label: "Back to courses", text: "Courses" };
  }

  const courseId = encodeURIComponent(location.courseId);
  const lectureId = encodeURIComponent(location.lectureId);
  if (location.scope === "public") {
    return {
      href: `/courses/${courseId}/lectures/${lectureId}`,
      label: "Back to lecture",
      text: "Lecture",
    };
  }

  if (!location.organizationId) {
    return { href: "/courses", label: "Back to courses", text: "Courses" };
  }
  const organizationId = encodeURIComponent(location.organizationId);
  const visibility =
    location.scope === "organization-private" ? "private" : "public";
  return {
    href: `/organizations/${organizationId}/courses/${visibility}/${courseId}/lectures/${lectureId}`,
    label: "Back to lecture",
    text: "Lecture",
  };
}

function getRunReturnTarget(location: CourseLocation | null | undefined): {
  href: string;
  label: string;
  text: string;
} {
  const route = courseRouteForRun(location);
  if (!route) {
    return { href: "/runs", label: "Back to My runs", text: "My runs" };
  }

  const courseId = encodeURIComponent(route.courseId);
  if (!location?.lectureId) {
    // The link shows the course title from md, so its name has to hold it.
    const courseText = location?.courseTitle ?? "Course";
    const courseLabel = location?.courseTitle
      ? `Back to course: ${location.courseTitle}`
      : "Back to course";
    switch (route.scope) {
      case "public":
        return {
          href: `/courses/${courseId}`,
          label: courseLabel,
          text: courseText,
        };
      case "organization-public":
      case "organization-private": {
        const organizationId = encodeURIComponent(route.organizationId!);
        const visibility =
          route.scope === "organization-private" ? "private" : "public";
        return {
          href: `/organizations/${organizationId}/courses/${visibility}/${courseId}`,
          label: courseLabel,
          text: courseText,
        };
      }
    }
  }

  const lectureId = encodeURIComponent(location.lectureId);
  switch (route.scope) {
    case "public":
      return {
        href: `/courses/${courseId}/lectures/${lectureId}`,
        label: "Back to lecture",
        text: "Lecture",
      };
    case "organization-public":
    case "organization-private": {
      const organizationId = encodeURIComponent(route.organizationId!);
      const visibility =
        route.scope === "organization-private" ? "private" : "public";
      return {
        href: `/organizations/${organizationId}/courses/${visibility}/${courseId}/lectures/${lectureId}`,
        label: "Back to lecture",
        text: "Lecture",
      };
    }
  }
}

async function fetchCurrentCourseCatalog(
  route: CourseRouteRef | null,
): Promise<CourseCatalogResponse> {
  if (!route) {
    throw new Error("A current course catalog is not available.");
  }
  return fetchCourseCatalog(route.organizationId);
}

async function navigateToRunCourse(
  navigate: ReturnType<typeof useNavigate>,
  location: CourseLocation | null | undefined,
  fallbackOrganizationId: string | null | undefined,
) {
  const route = courseRouteForRun(location);
  if (!route) {
    if (fallbackOrganizationId) {
      await navigate({
        to: "/organizations/$orgId/courses",
        params: { orgId: fallbackOrganizationId },
      });
      return;
    }
    await navigate({ to: "/courses" });
    return;
  }

  switch (route.scope) {
    case "public":
      await navigate({
        to: "/courses/$courseId",
        params: { courseId: route.courseId },
      });
      return;
    case "organization-public":
      if (route.organizationId) {
        await navigate({
          to: "/organizations/$orgId/courses/public/$courseId",
          params: { orgId: route.organizationId, courseId: route.courseId },
        });
        return;
      }
      break;
    case "organization-private":
      if (route.organizationId) {
        await navigate({
          to: "/organizations/$orgId/courses/private/$courseId",
          params: { orgId: route.organizationId, courseId: route.courseId },
        });
        return;
      }
      break;
  }
  await navigate({ to: "/courses" });
}

/** The run is public: anyone with the link can watch it. */
function SharedBadge() {
  return (
    <Badge variant="outline" className="gap-1.5">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-primary"
      />
      Live · shared
    </Badge>
  );
}

function ActiveRunStatus({
  tone,
  word,
  startedAt,
  leaseDeadlineMs,
  leaseHiddenOnPhone = false,
  frozenMs = null,
  pulse = false,
}: {
  tone: StatusTone;
  word: string;
  startedAt: number;
  leaseDeadlineMs: number | null;
  /** Drop the lease countdown below sm; it stays from sm up. */
  leaseHiddenOnPhone?: boolean;
  /** The clock stops here once the run is solved. */
  frozenMs?: number | null;
  pulse?: boolean;
}) {
  return (
    <span className="inline-flex min-w-max shrink-0 items-center gap-2">
      <StatusToken
        tone={tone}
        word={word}
        words={ACTIVE_RUN_STATUS_WORDS}
        pulse={pulse}
        clock={
          leaseDeadlineMs === null ? { startedAt, frozenMs } : undefined
        }
      />
      {leaseDeadlineMs !== null ? (
        <>
          <Separator
            orientation="vertical"
            aria-hidden="true"
            className={cn("h-3", leaseHiddenOnPhone && "max-sm:hidden")}
          />
          <LeaseCountdown
            deadlineMs={leaseDeadlineMs}
            {...(leaseHiddenOnPhone ? { className: "max-sm:hidden" } : {})}
          />
        </>
      ) : null}
    </span>
  );
}
