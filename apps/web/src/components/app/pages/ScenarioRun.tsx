import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  StatusToken,
  type StatusTone,
} from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { presentScenarioRun } from "@/lib/run-phase";
import { findNextCourseScenario } from "@/components/app/run/run-course-navigation";
import { RunLearningPanel } from "@/components/app/run/RunLearningPanel";
import { RunRecap } from "@/components/app/run/RunRecap";
import {
  DeleteRunDialog,
  ScenarioCancelDialog,
} from "@/components/app/run/RunDialogs";
import { ScenarioVmSelector } from "@/components/app/run/ScenarioVmSelector";
import {
  ScenarioShellStatusCard,
  ScenarioStepScreen,
} from "@/components/app/run/StatusScreens";
import {
  buildScenarioBootSteps,
  formatScenarioDurationMs,
  getScenarioBootScreenCopy,
  hasPendingInfrastructureTeardown,
  hasUsableTerminalTarget,
} from "@/components/app/run/run-support";
import { NativeSshDialog } from "@/components/remote-access/NativeSshDialogButton";
import {
  POLL_INTERVALS,
  type ScenarioRunResponse,
  type ScenarioDestroyAcceptedResponse,
} from "@/components/app/run/run-types";
import type {
  CourseLocation,
  ScenarioCatalogWireResponse,
} from "@/lib/scenario-runs";

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
  const runMutationFenceRef = useRef(0);
  const runQueryKey = useMemo(
    () => ["scenarios", "run", runId] as const,
    [runId],
  );
  const beginRunMutation = useCallback(async () => {
    runMutationFenceRef.current += 1;
    await queryClient.cancelQueries({ queryKey: runQueryKey, exact: true });
  }, [queryClient, runQueryKey]);
  const endRunMutation = useCallback(() => {
    runMutationFenceRef.current = Math.max(0, runMutationFenceRef.current - 1);
    if (runMutationFenceRef.current === 0) {
      void queryClient.invalidateQueries({
        queryKey: runQueryKey,
        exact: true,
      });
    }
  }, [queryClient, runQueryKey]);

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
    refetchInterval: (query) => {
      const record = query.state.data?.run;
      if (!record) return false;
      return POLL_INTERVALS[record.phase];
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    staleTime: 1_000,
  });

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
      queryClient.setQueryData(["scenarios", "run", runId], {
        run: presentScenarioRun(body.run),
      });
      setCancelDialogOpen(false);
      setTerminalVisible(false);
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] });
      void queryClient.invalidateQueries({
        queryKey: ["scenario-runs", "list"],
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
  const showResolutionCard =
    attemptData !== null &&
    attemptData.phase === "solved" &&
    attemptData.canDestroy;
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

    focusRecapAfterShutdownRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      recapHeadingRef.current?.focus({ preventScroll: true });
    });
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
  const showSshMenuItem = Boolean(
    selectedVm &&
    selectedVmSessionRequest &&
    attemptData?.outcome === "in_progress" &&
    attemptData.activity === "foreground",
  );
  const runLearningAction = useMemo(() => {
    if (!attemptData || attemptData.activity !== "foreground") {
      return undefined;
    }
    return (
      <RunLearningPanel
        phase={attemptData.phase}
        probes={selectedProbes}
        vmName={selectedVm?.scenarioVmName ?? null}
        objectives={attemptData.objectives}
        hints={attemptData.hints}
        solution={attemptData.solution}
        onRevealHint={(hintKey) => revealHint.mutate(hintKey)}
        pendingHintKey={
          revealHint.isPending ? (revealHint.variables ?? null) : null
        }
        hintError={
          revealHint.error instanceof Error ? revealHint.error.message : null
        }
        failedHintKey={
          revealHint.error ? (revealHint.variables ?? null) : null
        }
        onRevealSolution={() => revealSolution.mutate()}
        solutionPending={revealSolution.isPending}
        solutionError={
          revealSolution.error instanceof Error
            ? revealSolution.error.message
            : null
        }
        onFinishAndSave={
          showResolutionCard ? requestDestroyScenario : undefined
        }
        finishPending={destroyScenario.isPending}
        finishError={Boolean(destroyScenario.error)}
      />
    );
  }, [
    attemptData,
    selectedProbes,
    revealHint,
    revealSolution,
    showResolutionCard,
    requestDestroyScenario,
    destroyScenario.isPending,
    destroyScenario.error,
  ]);

  usePageChrome({
    title: attemptData?.title ?? "Lab run",
    status: useMemo(() => {
      if (!attemptData) return undefined;
      if (attemptData.outcome === "in_progress") {
        if (showSelectedVmPreparation || showBackgroundStatus) {
          return (
            <ActiveRunStatus
              tone="pending"
              word={attemptData.phaseTitle}
              compactWord={showBackgroundStatus ? "Ending" : "Starting"}
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
            />
          );
        }
        return (
          <ActiveRunStatus
            tone="live"
            word={attemptData.phaseTitle}
            compactWord="Live"
          />
        );
      }
      switch (attemptData.outcome) {
        case "succeeded":
          return (
            <StatusToken
              tone="success"
              word="Solved"
              elapsed={
                attemptData.solveDurationMs !== null
                  ? formatScenarioDurationMs(attemptData.solveDurationMs)
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
      showSelectedVmPreparation,
      showBackgroundStatus,
    ]),
    action: runLearningAction,
    menu: useMemo(() => {
      if (!showSshMenuItem && !showEndRunAction && !canDeleteRun) {
        return undefined;
      }
      return (
        <>
          {showSshMenuItem ? (
            <DropdownMenuItem
              disabled={!selectedVmShellReady}
              onClick={() => setSshDialogOpen(true)}
            >
              SSH command…
            </DropdownMenuItem>
          ) : null}
          {showSshMenuItem && (showEndRunAction || canDeleteRun) ? (
            <DropdownMenuSeparator />
          ) : null}
          {showEndRunAction ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setCancelDialogOpen(true)}
            >
              {acceptanceRetryNeeded ? "Retry end…" : "End run…"}
            </DropdownMenuItem>
          ) : null}
          {canDeleteRun ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteRunDialogOpen(true)}
            >
              Delete run…
            </DropdownMenuItem>
          ) : null}
        </>
      );
    }, [
      showSshMenuItem,
      showEndRunAction,
      canDeleteRun,
      selectedVmShellReady,
      acceptanceRetryNeeded,
    ]),
  });

  // The browser tab carries live-run state while the user is elsewhere.
  const scenarioName = attemptData?.title ?? null;
  const runIsLive = attemptData?.activity === "foreground";
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
      {showCancelAction ? (
        <ScenarioCancelDialog
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
      ) : null}
      {canDeleteRun ? (
        <DeleteRunDialog
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
      ) : null}
      {selectedVm && selectedVmSessionRequest ? (
        <NativeSshDialog
          vmName={selectedVm.scenarioVmName}
          sessionRequest={selectedVmSessionRequest}
          open={sshDialogOpen}
          onOpenChange={setSshDialogOpen}
        />
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

      {destroyScenario.error && !cancelDialogOpen ? (
        <Alert variant="destructive">
          <AlertTitle>Could not end run</AlertTitle>
          <AlertDescription>
            Your work is still open. Try ending the run again.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  if (attemptData && attemptData.activity !== "foreground") {
    return (
      <PageShell width="content">
        {runDialogs}
        {errorAlerts}
        <RunRecap
          run={attemptData}
          courseLocation={attemptData.courseLocation}
          nextScenario={nextCourseScenario}
          headingRef={recapHeadingRef}
        />
      </PageShell>
    );
  }

  // Everything else is the workspace frame: bar + panes, no page scroll.
  return (
    <div className="flex h-[calc(100dvh-var(--app-bar-h,3rem))] min-h-[28rem] flex-col gap-3 overflow-hidden px-[var(--workspace-inset)] py-3">
      {runDialogs}
      <div className="shrink-0 space-y-3 empty:hidden">{errorAlerts}</div>

      {attemptData ? (
        <section
          aria-label="Terminal"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3"
        >
          <ScenarioVmSelector
            vms={attemptData.vms}
            selectedVmId={selectedVmId}
            onSelect={setSelectedVmId}
          />

          {selectedVm && selectedVmShellReady && terminalVisible ? (
            <div className="relative min-h-[16rem] min-w-0 flex-1 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
              <WebSshTerminal
                vmName={selectedVm.scenarioVmName}
                sessionRequest={selectedVmSessionRequest!}
                variant="embedded"
                title={`${selectedVm.scenarioVmName} shell`}
                showCloseButton={false}
                onClose={() => setTerminalVisible(false)}
              />
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              {showSelectedVmPreparation ? (
                <div className="m-auto w-full max-w-2xl py-2">
                  <ScenarioStepScreen
                    title={bootScreenCopy.title}
                    description={bootScreenCopy.description}
                    steps={bootSteps}
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
      ) : null}
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
  pulse = false,
}: {
  tone: StatusTone;
  word: string;
  compactWord: string;
  pulse?: boolean;
}) {
  return (
    <StatusToken
      tone={tone}
      word={word}
      compactWord={compactWord}
      pulse={pulse}
    />
  );
}
