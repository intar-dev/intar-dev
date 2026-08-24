import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Maximize2, Minimize2, Trash2 } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { RunStatusDock } from "@/components/app/patterns/RunStatusDock";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { presentScenarioRun } from "@/lib/run-phase";
import { RunDetailsSection } from "@/components/app/run/RunDetailsSection";
import { RunTimeline } from "@/components/app/run/RunTimeline";
import { computeLeaseDeadline } from "@/lib/run-lease";
import { LeaseCountdown } from "@/components/app/run/LeaseCountdown";
import { repairObjectiveTitle } from "@/lib/verification-copy";
import {
  RepairProgressSection,
  RunConsole,
} from "@/components/app/run/RunConsole";
import { AssistDrawer } from "@/components/app/run/AssistDrawer";
import { ResolutionCard } from "@/components/app/run/ResolutionCard";
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
import { cn } from "@/lib/utils";
import type { CourseLocation } from "@/lib/scenario-runs";

export function ScenarioRun() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { runId } = useParams({ from: "/app/runs/$runId" });
  const [selectedVmId, setSelectedVmId] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteRunDialogOpen, setDeleteRunDialogOpen] = useState(false);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const timelineHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusTimelineAfterShutdownRef = useRef(false);
  const desktopRunRail = useDesktopRunRail();

  const attempt = useQuery({
    queryKey: ["scenarios", "run", runId],
    queryFn: async () => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
        {
          method: "GET",
          credentials: "include",
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

  const destroyScenario = useMutation({
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
      focusTimelineAfterShutdownRef.current = true;
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
  });

  const revealSolution = useMutation({
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
  });

  const attemptData = attempt.data?.run ?? null;
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
  const leaseDeadlineMs =
    attemptData !== null && attemptData.outcome === "in_progress"
      ? computeLeaseDeadline(
          attemptData.createdAt,
          attemptData.vms.map((vm) => vm.provisioning?.leaseDurationSeconds),
        )
      : null;
  const selectedProbes = selectedVm?.scenarioProbes ?? [];
  const passedCheckCount = selectedProbes.filter(
    (probe) => probe.status === "pass",
  ).length;
  const currentProbe =
    selectedProbes.find((probe) => probe.status !== "pass") ?? null;
  const currentObjectiveIndex = currentProbe
    ? (attemptData?.objectives.findIndex(
        (objective) => objective.probeName === currentProbe.id,
      ) ?? -1)
    : -1;
  const currentObjective =
    currentObjectiveIndex >= 0
      ? (attemptData?.objectives[currentObjectiveIndex] ?? null)
      : null;
  const currentCheckLabel =
    selectedProbes.length > 0 && passedCheckCount === selectedProbes.length
      ? "All objectives verified"
      : currentProbe
        ? repairObjectiveTitle(
            currentObjective,
            currentObjectiveIndex >= 0
              ? currentObjectiveIndex
              : Math.max(0, selectedProbes.indexOf(currentProbe)),
          )
        : attemptData?.phaseDetail || "Waiting for run status";
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
      !focusTimelineAfterShutdownRef.current ||
      !attemptData ||
      attemptData.activity === "foreground"
    ) {
      return;
    }

    focusTimelineAfterShutdownRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      timelineHeadingRef.current?.focus({ preventScroll: true });
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

  const requestDestroyScenario = () => {
    destroyScenario.reset();
    destroyScenario.mutate();
  };

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

  usePageChrome({
    title: attemptData?.scenarioName,
    status: useMemo(() => {
      if (!attemptData) return undefined;
      if (attemptData.outcome === "in_progress") {
        if (showSelectedVmPreparation || showBackgroundStatus) {
          return (
            <StatusToken
              tone="pending"
              word={attemptData.phaseTitle}
              pulse
              live={!showSelectedVmPreparation && !showBackgroundStatus}
              clock={{ startedAt: attemptData.createdAt }}
            />
          );
        }
        if (attemptData.phase === "solved") {
          return (
            <StatusToken
              tone="success"
              word="Solved"
              live
              clock={{
                startedAt: attemptData.createdAt,
                frozenMs: attemptData.solveDurationMs,
              }}
            />
          );
        }
        return (
          <StatusToken
            tone="live"
            word={attemptData.phaseTitle}
            live
            clock={{ startedAt: attemptData.createdAt }}
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
    }, [attemptData, showSelectedVmPreparation, showBackgroundStatus]),
    action: useMemo(
      () =>
        showEndRunAction ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setCancelDialogOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {acceptanceRetryNeeded ? "Retry end" : "End run"}
          </Button>
        ) : undefined,
      [showEndRunAction, acceptanceRetryNeeded],
    ),
    menu: useMemo(() => {
      if (!showSshMenuItem && !canDeleteRun) return undefined;
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
    }, [showSshMenuItem, canDeleteRun, selectedVmShellReady]),
  });

  // The browser tab carries live-run state while the user is elsewhere.
  const scenarioName = attemptData?.scenarioName ?? null;
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

  const maximizeToggle = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="hidden lg:inline-flex"
      aria-pressed={maximized}
      aria-label={maximized ? "Restore layout" : "Maximize terminal"}
      onClick={() => setMaximized((current) => !current)}
    >
      {maximized ? (
        <Minimize2 className="size-3.5" />
      ) : (
        <Maximize2 className="size-3.5" />
      )}
    </Button>
  );

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
            destroyScenario.error instanceof Error
              ? destroyScenario.error.message
              : null
          }
        />
      ) : null}
      {canDeleteRun ? (
        <DeleteRunDialog
          trigger={false}
          open={deleteRunDialogOpen}
          onOpenChange={setDeleteRunDialogOpen}
          onConfirm={() => deleteRun.mutate()}
          pending={deleteRun.isPending}
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

  const renderRunRail = () => {
    if (!attemptData) return null;

    if (showSelectedVmPreparation) {
      return (
        <RunConsole>
          <section aria-labelledby="startup-work-order-heading">
            <p className="text-eyebrow">Work order</p>
            <h2
              id="startup-work-order-heading"
              className="mt-2 font-heading text-base font-semibold"
            >
              Repair objectives
            </h2>
            {attemptData.objectives.length ? (
              <ol className="mt-3 space-y-3">
                {attemptData.objectives.map((objective, index) => (
                  <li
                    key={`${objective.probeName}:${index}`}
                    className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 text-sm"
                  >
                    <span className="font-heading font-semibold text-primary tabular-nums">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="font-medium leading-6">
                      {repairObjectiveTitle(objective, index)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Review the briefing before the shell opens.
              </p>
            )}
          </section>
          <section aria-labelledby="startup-briefing-heading">
            <p className="text-eyebrow">Briefing</p>
            <h2 id="startup-briefing-heading" className="sr-only">
              Incident briefing
            </h2>
            <Markdown className="mt-3 max-h-56 space-y-3 overflow-y-auto pr-1 text-sm leading-6 text-muted-foreground">
              {attemptData.briefingMarkdown}
            </Markdown>
          </section>
          <section aria-labelledby="startup-machine-heading">
            <div className="flex items-center justify-between gap-3">
              <p id="startup-machine-heading" className="text-eyebrow">
                Current machine
              </p>
              <StatusToken
                tone="pending"
                word={selectedVm?.phaseTitle ?? attemptData.phaseTitle}
                pulse
              />
            </div>
            <p className="mt-2 text-sm font-semibold">
              {selectedVm?.scenarioVmName ?? attemptData.scenarioName}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {selectedVm?.phaseDetail ?? attemptData.phaseDetail}
            </p>
          </section>
        </RunConsole>
      );
    }

    return (
      <RunConsole>
        {showResolutionCard ? (
          <div>
            <ResolutionCard
              runId={runId}
              scenarioName={attemptData.scenarioName}
              createdAt={attemptData.createdAt}
              solveDurationMs={attemptData.solveDurationMs}
              hints={attemptData.hints}
              objectives={attemptData.objectives}
              assisted={attemptData.solution.assisted}
              pending={destroyScenario.isPending}
              onEndScenario={requestDestroyScenario}
            />
          </div>
        ) : (
          <>
            {/* Keyed per machine so row open/close state never leaks across
                VM switches. */}
            <RepairProgressSection
              key={selectedVm?.scenarioVmName ?? "checks"}
              vmName={selectedVm?.scenarioVmName ?? null}
              probes={selectedProbes}
              objectives={attemptData.objectives}
            />
            <AssistDrawer
              hints={attemptData.hints}
              objectives={attemptData.objectives}
              solution={attemptData.solution}
              onRevealHint={(hintKey) => revealHint.mutate(hintKey)}
              pendingHintKey={
                revealHint.isPending ? (revealHint.variables ?? null) : null
              }
              hintError={
                revealHint.error instanceof Error
                  ? revealHint.error.message
                  : null
              }
              onRevealSolution={() => revealSolution.mutate()}
              solutionPending={revealSolution.isPending}
              solutionError={
                revealSolution.error instanceof Error
                  ? revealSolution.error.message
                  : null
              }
            />
          </>
        )}
        <RunDetailsSection
          runId={runId}
          objectives={attemptData.objectives}
          vmName={selectedVm?.scenarioVmName ?? null}
          hostname={selectedVm?.hostname ?? null}
          provisioning={selectedVm?.provisioning ?? null}
          terminalTarget={selectedVm?.terminalTarget ?? null}
        />
      </RunConsole>
    );
  };

  const errorAlerts = (
    <>
      {attempt.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load scenario run</AlertTitle>
          <AlertDescription>
            {attempt.error instanceof Error
              ? attempt.error.message
              : "Failed to load scenario run"}
          </AlertDescription>
        </Alert>
      ) : null}

      {destroyScenario.error && !cancelDialogOpen ? (
        <Alert variant="destructive">
          <AlertTitle>Could not end run</AlertTitle>
          <AlertDescription>
            {destroyScenario.error instanceof Error
              ? destroyScenario.error.message
              : "The active run could not be ended."}
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
        <RunTimeline run={attemptData} headingRef={timelineHeadingRef} />
      </PageShell>
    );
  }

  // Everything else is the workspace frame: bar + panes, no page scroll.
  return (
    <div className="flex h-[calc(100dvh-var(--app-bar-h,3rem))] min-h-[28rem] flex-col gap-3 overflow-hidden px-[var(--workspace-inset)] py-3">
      {runDialogs}
      <div className="shrink-0 space-y-3 empty:hidden">{errorAlerts}</div>
      {attemptData ? (
        <p className="shrink-0 font-heading text-sm font-semibold text-balance lg:hidden">
          {attemptData.title}
        </p>
      ) : null}

      {attemptData ? (
        <div
          className={cn(
            "grid min-h-0 flex-1 gap-3 lg:grid-rows-[minmax(0,1fr)]",
            !maximized && "lg:grid-cols-[minmax(0,1fr)_22rem]",
          )}
        >
          <section
            aria-label="Terminal"
            className="relative flex min-h-0 min-w-0 flex-col gap-3"
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
                  headerActions={
                    <>
                      <LeaseCountdown
                        deadlineMs={leaseDeadlineMs}
                        className="text-xs"
                      />
                      {maximizeToggle}
                    </>
                  }
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
                      topRight={
                        <StatusToken
                          tone="pending"
                          word="Elapsed"
                          clock={{ startedAt: attemptData.createdAt }}
                        />
                      }
                    />
                  </div>
                ) : (
                  <>
                    {/* The lease keeps ticking without a terminal — keep the
                        countdown's only home visible in this state too. */}
                    <div className="flex shrink-0 justify-end empty:hidden">
                      <LeaseCountdown
                        deadlineMs={leaseDeadlineMs}
                        className="text-xs"
                      />
                    </div>
                    <ScenarioShellStatusCard
                      phase={selectedVm?.phase ?? attemptData.phase}
                      title={selectedVm?.phaseTitle ?? attemptData.phaseTitle}
                      description={
                        selectedVm?.phaseDetail ?? attemptData.phaseDetail
                      }
                      pending={
                        !selectedVmShellReady &&
                        Boolean(selectedVm && selectedVm.phase !== "failed")
                      }
                    />
                  </>
                )}
              </div>
            )}

            <div
              aria-hidden="true"
              className="h-[calc(4.5rem+env(safe-area-inset-bottom))] shrink-0 lg:hidden"
            />
          </section>

          {desktopRunRail ? (
            <aside
              aria-label="Run console"
              className={cn(
                "min-h-0 overflow-y-auto pr-1",
                maximized && "hidden",
              )}
            >
              {renderRunRail()}
            </aside>
          ) : (
            <RunStatusDock
              label={
                showSelectedVmPreparation
                  ? "Work order and briefing"
                  : "Run checks and assistance"
              }
              description={
                showSelectedVmPreparation
                  ? "Review the objectives, incident context, and current machine state while the VM starts."
                  : "Review live checks, hints, solution, and machine details without leaving the shell."
              }
              status={
                showSelectedVmPreparation
                  ? (selectedVm?.phaseDetail ?? attemptData.phaseDetail)
                  : selectedProbes.length
                    ? `${passedCheckCount}/${selectedProbes.length} checks · ${currentCheckLabel}`
                    : attemptData.phaseDetail
              }
            >
              {renderRunRail()}
            </RunStatusDock>
          )}
        </div>
      ) : null}
    </div>
  );
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

function useDesktopRunRail() {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(min-width: 64rem)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return matches;
}
