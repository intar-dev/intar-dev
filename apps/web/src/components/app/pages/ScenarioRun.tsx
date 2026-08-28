import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  HttpResponseError,
  isAccessResponseError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";
import { PageShell } from "@/components/app/patterns/PageShell";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import {
  StatusToken,
  type StatusTone,
} from "@/components/app/patterns/StatusToken";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { presentScenarioRun } from "@/lib/run-phase";
import { findNextCourseScenario } from "@/components/app/run/run-course-navigation";
import { RunCompletionBar } from "@/components/app/run/RunCompletionBar";
import { LeaseCountdown } from "@/components/app/run/LeaseCountdown";
import {
  RunLearningPanel,
  RunLearningPanelMobile,
} from "@/components/app/run/RunLearningPanel";
import { ScenarioVmSelector } from "@/components/app/run/ScenarioVmSelector";
import {
  ScenarioShellStatusCard,
  ScenarioStepScreen,
} from "@/components/app/run/StatusScreens";
import {
  buildScenarioBootSteps,
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
  ScenarioCatalogWireResponse,
} from "@/lib/scenario-runs";
import { computeLeaseDeadline } from "@/lib/run-lease";
import { cn } from "@/lib/utils";

const LazyWebSshTerminal = lazy(() =>
  import("@/components/remote-access/WebSshTerminal").then(
    ({ WebSshTerminal }) => ({ default: WebSshTerminal }),
  ),
);
const LazyNativeSshDialog = lazy(() =>
  import("@/components/remote-access/NativeSshDialogButton").then(
    ({ NativeSshDialog }) => ({ default: NativeSshDialog }),
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

interface ScenarioRunStatusPollResult {
  status: ScenarioRunStatus | null;
  version: string;
}

export function ScenarioRun() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { runId } = useParams({ from: "/app/runs/$runId" });
  const [selectedVmId, setSelectedVmId] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteRunDialogOpen, setDeleteRunDialogOpen] = useState(false);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
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

  const runStatus = useQuery({
    queryKey: runStatusQueryKey,
    enabled:
      Boolean(attempt.data?.run) &&
      attempt.data?.run.activity !== "settled" &&
      runMutationFenceRef.current === 0,
    queryFn: async ({ signal }): Promise<ScenarioRunStatusPollResult> => {
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
          signal,
        },
      );
      if (response.status === 204) {
        return { status: null, version };
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
      return { status: body.status, version: body.status.version };
    },
    refetchInterval: (query) => {
      const record = queryClient.getQueryData<ScenarioRunResponse>(runQueryKey)?.run;
      return scenarioRunStatusRefetchInterval(record, query.state.error);
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    staleTime: 0,
    retry: retryHttpResponseError,
  });

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
  const shouldLoadNextCourseScenario =
    completedCourseLocation?.courseKind === "authored";
  const currentCourse = useQuery({
    queryKey: [
      "scenario-run",
      runId,
      "current-course",
      completedCourseLocation?.scope ?? null,
      completedCourseLocation?.organizationId ?? null,
      completedCourseLocation?.courseId ?? null,
    ],
    queryFn: () => fetchCurrentCourseCatalog(completedCourseLocation),
    enabled: shouldLoadNextCourseScenario,
    staleTime: 0,
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
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] });
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "summary"],
      });
    },
    onSettled: endRunMutation,
  });

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
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] });
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
          attemptData.scenarioId,
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

  const attemptData = attempt.data?.run ?? null;
  const nextCourseScenario = useMemo(
    () =>
      attemptData && currentCourse.data
        ? findNextCourseScenario({
            location: completedCourseLocation,
            scenarioId: attemptData.scenarioId,
            courses: currentCourse.data.courses,
          })
        : null,
    [attemptData, completedCourseLocation, currentCourse.data],
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
  const showSelectedVmPreparation = Boolean(
    attemptData &&
    !selectedVmShellReady &&
    (!selectedVm ||
      selectedVm.phase === "launching" ||
      selectedVm.phase === "booting" ||
      selectedVm.phase === "waiting_for_target"),
  );
  const showBackgroundStatus = attemptData?.activity === "background";
  const acceptanceRetryNeeded = Boolean(
    attemptData?.activity === "foreground" &&
    attemptData.deleteRequestedAt !== null,
  );
  const showCancelAction =
    attemptData !== null &&
    attemptData.activity === "foreground" &&
    (attemptData.canDestroy || acceptanceRetryNeeded) &&
    attemptData.phase !== "solved";
  const showFinishBar =
    attemptData !== null &&
    attemptData.phase === "solved" &&
    attemptData.activity === "foreground";
  const leaseDeadlineMs =
    attemptData !== null && attemptData.outcome === "in_progress"
      ? computeLeaseDeadline(
          attemptData.createdAt,
          attemptData.vms.map((vm) => vm.provisioning?.leaseDurationSeconds),
        )
      : null;
  const selectedProbes = selectedVm?.scenarioProbes ?? [];
  const infrastructureTeardownPending = Boolean(
    attemptData && hasPendingInfrastructureTeardown(attemptData.vms),
  );
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

  useEffect(() => {
    if (selectedVmShellReady) {
      setTerminalVisible(true);
    }
  }, [selectedVmShellReady]);

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
    if (showBackgroundStatus) {
      return (
        <ActiveRunStatus
          tone="pending"
          word="Saving"
          compactWord="Saving"
          startedAt={attemptData.createdAt}
          leaseDeadlineMs={leaseDeadlineMs}
          compact
          pulse
        />
      );
    }
    if (attemptData.outcome === "in_progress") {
      if (showSelectedVmPreparation) {
        return (
          <ActiveRunStatus
            tone="pending"
            word={attemptData.phaseTitle}
            compactWord="Starting"
            startedAt={attemptData.createdAt}
            leaseDeadlineMs={leaseDeadlineMs}
            pulse
          />
        );
      }
      if (attemptData.phase === "solved") {
        return (
          <ActiveRunStatus
            tone="success"
            word="Solved"
            compactWord="Solved"
            startedAt={attemptData.createdAt}
            leaseDeadlineMs={leaseDeadlineMs}
          />
        );
      }
      return (
        <ActiveRunStatus
          tone="live"
          word={attemptData.phaseTitle}
          compactWord="Live"
          startedAt={attemptData.createdAt}
          leaseDeadlineMs={leaseDeadlineMs}
        />
      );
    }
    switch (attemptData.outcome) {
      case "succeeded":
        return <StatusToken tone="success" word="Solved" />;
      case "failed":
        return <StatusToken tone="danger" word="Failed" />;
      default:
        return <StatusToken tone="muted" word="Ended early" />;
    }
  }, [
    attemptData,
    leaseDeadlineMs,
    showSelectedVmPreparation,
    showBackgroundStatus,
  ]);

  const runIsLive = attemptData?.activity === "foreground";
  const deleteRunAction = useMemo(
    () =>
      canDeleteRun ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={() => setDeleteRunDialogOpen(true)}
        >
          Delete run…
        </Button>
      ) : undefined,
    [canDeleteRun],
  );
  usePageChrome({
    title: attemptData?.title ?? "Lab run",
    status: runIsLive ? undefined : runStatusDisplay,
    action: runIsLive ? undefined : deleteRunAction,
    fullscreen: runIsLive,
  });

  const runActions =
    showSshAction || showEndRunAction || canDeleteRun ? (
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Run actions"
        data-run-actions
      >
        {showSshAction ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!selectedVmShellReady}
            onClick={() => setSshDialogOpen(true)}
          >
            SSH command
          </Button>
        ) : null}
        {showEndRunAction ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setCancelDialogOpen(true)}
          >
            {acceptanceRetryNeeded ? "Retry end…" : "End run…"}
          </Button>
        ) : null}
        {canDeleteRun ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setDeleteRunDialogOpen(true)}
          >
            Delete run…
          </Button>
        ) : null}
      </div>
    ) : null;

  const guidanceProps =
    attemptData?.activity === "foreground"
      ? {
          briefingMarkdown: attemptData.briefingMarkdown,
          phase: attemptData.phase,
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
          failedHintKey: revealHint.error
            ? (revealHint.variables ?? null)
            : null,
          onRevealSolution: () => revealSolution.mutate(),
          solutionPending: revealSolution.isPending,
          solutionError:
            revealSolution.error instanceof Error
              ? revealSolution.error.message
              : null,
        }
      : null;

  // The browser tab carries live-run state while the user is elsewhere.
  const scenarioName = attemptData?.title ?? null;
  useEffect(() => {
    if (!runIsLive || !scenarioName) return;
    const previous = document.title;
    const live = `● ${scenarioName} · intar.dev`;
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
      {showCancelAction && cancelDialogOpen ? (
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
      {canDeleteRun && deleteRunDialogOpen ? (
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
      {selectedVm && selectedVmSessionRequest && sshDialogOpen ? (
        <Suspense fallback={null}>
          <LazyNativeSshDialog
            vmName={selectedVm.scenarioVmName}
            sessionRequest={selectedVmSessionRequest}
            open={sshDialogOpen}
            onOpenChange={setSshDialogOpen}
          />
        </Suspense>
      ) : null}
    </>
  );

  const errorAlerts = (
    <>
      {attempt.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load this lab</AlertTitle>
          <AlertDescription>
            Refresh the page or return to My runs and try again.
          </AlertDescription>
        </Alert>
      ) : null}

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
      <PageShell width="content">
        {runDialogs}
        {errorAlerts}
        {!attempt.error ? (
          <p
            className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"
            role="status"
          >
            Loading your lab…
          </p>
        ) : null}
      </PageShell>
    );
  }

  if (attemptData.activity !== "foreground") {
    return (
      <PageShell width="content">
        {runDialogs}
        {errorAlerts}
        <Suspense
          fallback={
            <section
              className="mx-auto flex w-full max-w-2xl flex-1 items-center justify-center py-8 text-sm text-muted-foreground"
              role="status"
            >
              Loading your recap…
            </section>
          }
        >
          <LazyRunRecap
            run={attemptData}
            courseLocation={attemptData.courseLocation}
            nextScenario={nextCourseScenario}
            headingRef={recapHeadingRef}
          />
        </Suspense>
      </PageShell>
    );
  }

  // A live run owns the viewport: runtime on the left, learning reference on
  // the right, and no page-level scroll around either surface.
  return (
    <RunPageFrame>
      {runDialogs}
      <div
        data-run-workspace
        className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden [@media(min-width:960px)]:grid-cols-[minmax(0,1fr)_min(24rem,40vw)]"
      >
        <div
          data-run-work-area
          className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
        >
          <RunWorkspaceHeader
            title={attemptData.title}
            status={runStatusDisplay}
            actions={runActions}
            mobileGuidance={
              guidanceProps ? (
                <RunLearningPanelMobile {...guidanceProps} />
              ) : null
            }
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3 [@media(max-height:500px)]:!p-3">
            <div className="shrink-0 space-y-2 empty:hidden">
              {errorAlerts}
            </div>

            {showFinishBar ? (
              <RunCompletionBar
                canFinish={attemptData.canDestroy}
                pending={destroyScenario.isPending}
                error={Boolean(destroyScenario.error)}
                onFinish={requestDestroyScenario}
              />
            ) : null}

            <section
              aria-label="Terminal"
              className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2"
            >
              <ScenarioVmSelector
                vms={attemptData.vms}
                selectedVmId={selectedVmId}
                onSelect={setSelectedVmId}
              />

              {selectedVm && selectedVmShellReady && terminalVisible ? (
                <div className="relative min-h-0 min-w-0 flex-1 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
                  <Suspense
                    fallback={
                      <div
                        className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground"
                        role="status"
                      >
                        Opening secure shell…
                      </div>
                    }
                  >
                    <LazyWebSshTerminal
                      vmName={selectedVm.scenarioVmName}
                      sessionRequest={selectedVmSessionRequest!}
                      variant="embedded"
                      title={`${selectedVm.scenarioVmName} shell`}
                      showCloseButton={false}
                      onClose={() => setTerminalVisible(false)}
                    />
                  </Suspense>
                </div>
              ) : (
                <div
                  aria-label={
                    showSelectedVmPreparation
                      ? "Workspace startup progress"
                      : undefined
                  }
                  className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
                  role={showSelectedVmPreparation ? "region" : undefined}
                  tabIndex={showSelectedVmPreparation ? 0 : undefined}
                >
                  {showSelectedVmPreparation ? (
                    <div
                      className="m-auto w-full max-w-2xl py-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:py-6"
                      data-run-sequence-frame
                    >
                      <ScenarioStepScreen
                        title={bootScreenCopy.title}
                        description={bootScreenCopy.description}
                        steps={bootSteps}
                        listLabel="Startup steps"
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
          </div>
        </div>

        {guidanceProps ? <RunLearningPanel {...guidanceProps} /> : null}
      </div>
    </RunPageFrame>
  );
}

function RunPageFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-run-page
      className="flex h-[100dvh] max-h-[100dvh] min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      <header
        className="flex h-12 shrink-0 items-center border-b bg-background px-3"
        data-run-navigation
      >
        {/* Keep this a document navigation. Repeated run/list transitions hit
            the current router intent-preload bug, and leaving the document
            also guarantees that the terminal transport is released. */}
        <a
          href="/runs"
          className={buttonVariants({
            variant: "ghost",
            className: "-ml-2 [@media(pointer:coarse)]:min-h-11",
          })}
          aria-label="Back to My runs"
          data-run-back
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </a>
      </header>
      {children}
    </div>
  );
}

function RunWorkspaceHeader({
  title,
  status,
  actions,
  mobileGuidance,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  mobileGuidance?: ReactNode;
}) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2"
      data-run-workspace-header
    >
      <h1 className="min-w-[min(16rem,100%)] flex-1 basis-64 text-section-title">
        {title}
      </h1>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {status ? <div className="mr-1 min-w-0">{status}</div> : null}
        {mobileGuidance}
        {actions}
      </div>
    </div>
  );
}

async function fetchCurrentCourseCatalog(
  location: CourseLocation | null,
): Promise<ScenarioCatalogWireResponse> {
  if (!location || location.courseKind !== "authored") {
    throw new Error("A current course catalog is not available.");
  }

  const endpoint = location.organizationId
    ? `/api/organizations/${encodeURIComponent(location.organizationId)}/scenarios`
    : "/api/scenarios";
  const response = await fetch(endpoint, {
    method: "GET",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to load current course (${response.status})`);
  }
  return (await response.json()) as ScenarioCatalogWireResponse;
}

async function navigateToRunCourse(
  navigate: ReturnType<typeof useNavigate>,
  location: CourseLocation | null | undefined,
  scenarioId: string,
  fallbackOrganizationId: string | null | undefined,
) {
  if (!location) {
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

  const courseId = location.courseId ?? "general-practice";
  switch (location.scope) {
    case "public":
      await navigate({
        to: "/courses/$courseId/$scenarioId",
        params: { courseId, scenarioId },
      });
      return;
    case "organization-public":
      if (location.organizationId) {
        await navigate({
          to: "/organizations/$orgId/courses/public/$courseId/$scenarioId",
          params: { orgId: location.organizationId, courseId, scenarioId },
        });
        return;
      }
      break;
    case "organization-private":
      if (location.organizationId) {
        await navigate({
          to: "/organizations/$orgId/courses/private/$courseId/$scenarioId",
          params: { orgId: location.organizationId, courseId, scenarioId },
        });
        return;
      }
      break;
    case "organization-general-practice":
      if (location.organizationId) {
        await navigate({
          to: "/organizations/$orgId/courses/general-practice/$scenarioId",
          params: { orgId: location.organizationId, scenarioId },
        });
        return;
      }
      break;
  }
  await navigate({ to: "/courses" });
}

function ActiveRunStatus({
  tone,
  word,
  compactWord,
  startedAt,
  leaseDeadlineMs,
  compact = false,
  pulse = false,
}: {
  tone: StatusTone;
  word: string;
  compactWord: string;
  startedAt: number;
  leaseDeadlineMs: number | null;
  compact?: boolean;
  pulse?: boolean;
}) {
  return (
    <span className="inline-flex min-w-max shrink-0 items-center gap-2.5">
      <StatusToken
        tone={tone}
        word={word}
        compactWord={compactWord}
        pulse={pulse}
        clock={leaseDeadlineMs === null && !compact ? { startedAt } : undefined}
      />
      {leaseDeadlineMs !== null ? (
        <>
          <span
            aria-hidden="true"
            className={cn("h-3 w-px bg-border", compact && "hidden sm:block")}
          />
          <LeaseCountdown
            deadlineMs={leaseDeadlineMs}
            {...(compact ? { className: "hidden sm:inline-flex" } : {})}
          />
        </>
      ) : null}
    </span>
  );
}
