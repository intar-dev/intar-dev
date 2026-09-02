import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  Lightbulb,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  isVerificationPassed,
  repairObjectiveTitle,
} from "@/lib/verification-copy";
import type {
  ScenarioObjective,
  ScenarioProbeStatus,
  ScenarioRunHint,
  ScenarioRunRecord,
  ScenarioRunSolution,
} from "./run-types";

type LearningPanelState = "booting" | "running" | "solved";

export interface RunLearningPanelProps {
  /** Pass the selected VM's scenario probes, never the full run probe list. */
  probes: readonly ScenarioProbeStatus[];
  /** Authored name of the selected VM; scopes duplicate probe names safely. */
  vmName?: string | null;
  /** V1 fallback when a run predates its immutable lecture snapshot. */
  briefingMarkdown: string;
  /** Immutable theory the learner read before starting this run. */
  lectureMarkdown?: string | null | undefined;
  lectureTitle?: string | null | undefined;
  objectives: readonly ScenarioObjective[];
  hints: readonly ScenarioRunHint[];
  solution: ScenarioRunSolution;
  phase: ScenarioRunRecord["phase"] | null | undefined;
  onRevealHint: (hintKey: string) => void;
  pendingHintKey?: string | null;
  /** A non-empty value means the last hint reveal failed. Its text is never rendered. */
  hintError?: string | null;
  /** Set this to the failed mutation's hint key so the error stays beside its action. */
  failedHintKey?: string | null;
  onRevealSolution: () => void;
  solutionPending?: boolean;
  /** A non-empty value means the solution reveal failed. Its text is never rendered. */
  solutionError?: string | null;
  className?: string;
}

export interface RunLearningPanelContentProps
  extends Omit<RunLearningPanelProps, "className"> {
  className?: string;
}

interface HintGroup {
  key: string;
  label: string;
  hints: readonly ScenarioRunHint[];
}

export interface RunLearningTriggerCopy {
  visibleLabel: string;
  accessibleLabel: string;
}

export type LearnerCheckStatus =
  | "verified"
  | "checking"
  | "needs_repair";

export interface LearnerCheck {
  /** React identity only. Never render this internal value. */
  key: string;
  title: string;
  status: LearnerCheckStatus;
  statusLabel: "Verified" | "Checking" | "Needs repair";
}

/** Learner-facing states only; internal phase titles never render here. */
export function getRunLearningPanelState(
  phase: RunLearningPanelProps["phase"],
): LearningPanelState {
  if (
    phase === "launching" ||
    phase === "booting" ||
    phase === "waiting_for_target"
  ) {
    return "booting";
  }
  return phase === "solved" ? "solved" : "running";
}

export function getRunLearningTriggerCopy(input: {
  passedChecks: number;
  totalChecks: number;
  revealedHints: number;
  totalHints: number;
}): RunLearningTriggerCopy {
  const checks = `${input.passedChecks} of ${input.totalChecks} checks verified`;
  const hints = input.totalHints
    ? `${input.revealedHints} of ${input.totalHints} hints revealed`
    : "No hints are available";
  return {
    visibleLabel: `Checks ${input.passedChecks}/${input.totalChecks}`,
    accessibleLabel: `Open lecture theory and hints. ${hints}. ${checks}.`,
  };
}

/**
 * The permanent desktop guidance pane. ScenarioRun places this in its second
 * grid column. Its pinned checks and supporting content stay reachable while
 * terminal work remains fixed in the first column.
 */
export function RunLearningPanel(props: RunLearningPanelProps) {
  const { className, ...contentProps } = props;
  const desktop = useDesktopLearningPanel(true);
  const passedChecks = countPassedChecks(props.probes);
  const announcement = useCheckAnnouncement({
    passedChecks,
    totalChecks: props.probes.length,
  });

  if (!desktop) return null;

  return (
    <aside
      aria-label="Lecture theory and hints"
      data-run-learning-panel
      className={cn(
        "hidden h-full min-h-0 min-w-0 w-full border-l bg-card min-[960px]:flex min-[960px]:flex-col",
        className,
      )}
    >
      <div
        data-run-learning-panel-scroll
        className="min-h-0 flex-1 scroll-py-4 overflow-y-auto overscroll-contain bg-card px-4 py-4"
        role="region"
        aria-label="Lecture theory and hints content"
        tabIndex={0}
      >
        <RunLearningPanelContent {...contentProps} />
      </div>
      <RunLearningPanelAnnouncement announcement={announcement} />
    </aside>
  );
}

/**
 * The compact trigger and bottom sheet for the run toolbar. It deliberately
 * has no desktop right-rail behavior: desktop renders RunLearningPanel.
 */
export function RunLearningPanelMobile(props: RunLearningPanelProps) {
  const { className, ...contentProps } = props;
  const desktop = useDesktopLearningPanel(false);
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const passedChecks = countPassedChecks(props.probes);
  const hints = useMemo(
    () => scopeHintsToVm(props.hints, props.vmName),
    [props.hints, props.vmName],
  );
  const copy = getRunLearningTriggerCopy({
    passedChecks,
    totalChecks: props.probes.length,
    revealedHints: countRevealedHints(hints),
    totalHints: hints.length,
  });
  const announcement = useCheckAnnouncement({
    passedChecks,
    totalChecks: props.probes.length,
  });

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      const shouldRestoreFocus = restoreFocusRef.current;
      restoreFocusRef.current = true;
      if (!shouldRestoreFocus) {
        wasOpenRef.current = open;
        return undefined;
      }
      const opener = openerRef.current;
      const frame = window.requestAnimationFrame(() =>
        opener?.focus({ preventScroll: true }),
      );
      wasOpenRef.current = open;
      return () => window.cancelAnimationFrame(frame);
    }
    wasOpenRef.current = open;
    return undefined;
  }, [open]);

  useEffect(() => {
    if (desktop) {
      restoreFocusRef.current = false;
      openerRef.current = null;
      wasOpenRef.current = false;
      setOpen(false);
    }
  }, [desktop]);

  const rememberOpener = (event: ReactMouseEvent<HTMLElement>) => {
    openerRef.current = event.currentTarget;
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && window.matchMedia("(min-width: 960px)").matches) {
      restoreFocusRef.current = false;
      setOpen(false);
      return;
    }
    if (nextOpen) restoreFocusRef.current = true;
    setOpen(nextOpen);
  };

  if (desktop) return null;

  return (
    <div
      data-run-learning-mobile
      className={cn("min-[960px]:hidden", className)}
    >
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 gap-2 px-3"
              aria-label={copy.accessibleLabel}
              data-run-learning-panel-trigger
              onClick={rememberOpener}
            />
          }
        >
          <Lightbulb className="size-4" aria-hidden="true" />
          {copy.visibleLabel}
        </SheetTrigger>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-run-learning-mobile-sheet
          className="max-h-[min(78dvh,42rem)] gap-0 overflow-hidden rounded-t-2xl border-x border-t bg-card pb-[max(1rem,env(safe-area-inset-bottom))] !shadow-none motion-reduce:transition-none"
        >
          <LearningPanelA11yHeader />
          <LearningPanelClose />
          <div
            data-run-learning-mobile-scroll
            className="min-h-0 flex-1 scroll-py-4 overflow-y-auto overscroll-contain bg-card px-4"
            role="region"
            aria-label="Lecture theory and hints content"
            tabIndex={0}
          >
            <RunLearningPanelContent {...contentProps} />
          </div>
        </SheetContent>
      </Sheet>
      <RunLearningPanelAnnouncement announcement={announcement} />
    </div>
  );
}

function RunLearningPanelAnnouncement({ announcement }: { announcement: string }) {
  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </p>
  );
}

/**
 * The interior is exported separately for focused SSR tests and to guarantee
 * the desktop pane and mobile sheet present exactly the same learning flow.
 */
export function RunLearningPanelContent(props: RunLearningPanelContentProps) {
  const state = getRunLearningPanelState(props.phase);
  const passedChecks = countPassedChecks(props.probes);
  const hints = useMemo(
    () => scopeHintsToVm(props.hints, props.vmName),
    [props.hints, props.vmName],
  );
  const revealedHints = countRevealedHints(hints);
  const objectives = useMemo(
    () => scopeObjectivesToVm(props.objectives, props.vmName),
    [props.objectives, props.vmName],
  );
  const theoryHeadingId = useId();
  const workOrderHeadingId = useId();
  const checksHeadingId = useId();
  const hintsHeadingId = useId();
  const solutionHeadingId = useId();

  return (
    <div
      data-run-learning-panel-content
      className={cn("space-y-6 bg-card pb-6", props.className)}
    >
      {state !== "booting" ? (
        <div
          className="sticky top-0 z-20 -mx-1 isolate bg-card px-1 pb-3"
          data-run-pinned-checks
        >
          <Checks
            headingId={checksHeadingId}
            probes={props.probes}
            objectives={objectives}
            passedChecks={passedChecks}
            pinned
          />
        </div>
      ) : null}

      <LectureTheory
        headingId={theoryHeadingId}
        briefingMarkdown={props.briefingMarkdown}
        lectureMarkdown={props.lectureMarkdown}
        lectureTitle={props.lectureTitle}
      />

      {state === "booting" ? (
        <WorkOrder headingId={workOrderHeadingId} objectives={objectives} />
      ) : null}

      <Hints
        headingId={hintsHeadingId}
        hints={hints}
        objectives={objectives}
        onRevealHint={props.onRevealHint}
        pendingHintKey={props.pendingHintKey ?? null}
        hintError={props.hintError ?? null}
        failedHintKey={props.failedHintKey ?? null}
        revealedHints={revealedHints}
      />

      <Solution
        headingId={solutionHeadingId}
        solution={props.solution}
        requiresConfirmation={state !== "solved"}
        onRevealSolution={props.onRevealSolution}
        pending={props.solutionPending ?? false}
        error={props.solutionError ?? null}
      />
    </div>
  );
}

function LearningPanelA11yHeader() {
  return (
    <SheetHeader className="sr-only">
      <SheetTitle>Lecture theory and hints</SheetTitle>
      <SheetDescription>
        Your lecture theory, checks, hints, and solution.
      </SheetDescription>
    </SheetHeader>
  );
}

function LearningPanelClose() {
  return (
    <SheetClose
      render={
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3 z-30"
          aria-label="Close lecture theory and hints"
        />
      }
    >
      <X className="size-4" aria-hidden="true" />
    </SheetClose>
  );
}

function CheckStatusIcon({ status }: { status: LearnerCheckStatus }) {
  if (status === "verified") {
    return (
      <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
    );
  }
  if (status === "checking") {
    return (
      <LoaderCircle
        className="size-4 text-warning motion-safe:animate-spin"
        aria-hidden="true"
      />
    );
  }
  return <CircleAlert className="size-4 text-destructive" aria-hidden="true" />;
}

function LectureTheory(props: {
  headingId: string;
  briefingMarkdown: string;
  lectureMarkdown?: string | null | undefined;
  lectureTitle?: string | null | undefined;
}) {
  const theory = (props.lectureMarkdown ?? props.briefingMarkdown).trim();

  return (
    <section aria-labelledby={props.headingId}>
      <h2 id={props.headingId} className="text-card-title">
        {props.lectureTitle
          ? `Lecture theory: ${props.lectureTitle}`
          : "Lecture theory"}
      </h2>
      {theory ? (
        <Markdown
          headingOffset={1}
          className="mt-3 space-y-3 text-sm leading-6"
        >
          {theory}
        </Markdown>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          No lecture theory is available for this run.
        </p>
      )}
    </section>
  );
}

function WorkOrder(props: {
  headingId: string;
  objectives: readonly ScenarioObjective[];
}) {
  return (
    <section aria-labelledby={props.headingId}>
      <div className="flex items-center justify-between gap-3">
        <p id={props.headingId} className="text-label">
          Work order
        </p>
        <Lightbulb className="size-4 text-primary" aria-hidden="true" />
      </div>
      {props.objectives.length ? (
        <ol className="mt-3 divide-y border-y">
          {props.objectives.map((objective, index) => (
            <li
              key={`${objective.probeName}:${index}`}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-4"
            >
              <span className="font-heading text-sm font-semibold text-primary tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-sm font-medium leading-6">
                {repairObjectiveTitle(objective, index)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Your work order will appear when the scenario is ready.
        </p>
      )}
    </section>
  );
}

function Checks(props: {
  headingId: string;
  probes: readonly ScenarioProbeStatus[];
  objectives: readonly ScenarioObjective[];
  passedChecks: number;
  pinned?: boolean;
}) {
  const checks = getLearnerChecks(props.probes, props.objectives);

  return (
    <section
      aria-labelledby={props.headingId}
      className={cn(
        props.pinned &&
          "flex max-h-[min(44dvh,24rem)] min-h-0 flex-col bg-card",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p id={props.headingId} className="text-label">
          Checks
        </p>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          aria-label={`${props.passedChecks} of ${checks.length} checks verified`}
        >
          {props.passedChecks}/{checks.length} verified
        </span>
      </div>
      {checks.length ? (
        <ol
          tabIndex={props.pinned ? 0 : undefined}
          aria-label={props.pinned ? "Checks list" : undefined}
          className={cn(
            "mt-4 divide-y border-y",
            props.pinned &&
              "min-h-0 overflow-y-auto overscroll-contain pr-1",
          )}
        >
          {checks.map((check) => {
            return (
              <li
                key={check.key}
                className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-3 py-4"
              >
                <span className="mt-0.5">
                  <CheckStatusIcon status={check.status} />
                </span>
                <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 text-sm font-medium leading-6 [overflow-wrap:anywhere]">
                    {check.title}
                  </span>
                  <span
                    className={cn(
                      "pt-0.5 text-xs font-medium whitespace-nowrap",
                      check.status === "verified"
                        ? "text-success"
                        : check.status === "checking"
                          ? "text-warning"
                          : "text-destructive",
                    )}
                  >
                    {check.statusLabel}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          No checks are available yet.
        </p>
      )}
    </section>
  );
}

function Hints(props: {
  headingId: string;
  hints: readonly ScenarioRunHint[];
  objectives: readonly ScenarioObjective[];
  onRevealHint: (hintKey: string) => void;
  pendingHintKey: string | null;
  hintError: string | null;
  failedHintKey: string | null;
  revealedHints: number;
}) {
  const groups = useMemo(
    () => groupHints(props.hints, props.objectives),
    [props.hints, props.objectives],
  );

  return (
    <section aria-labelledby={props.headingId}>
      <div className="flex items-center justify-between gap-3">
        <p id={props.headingId} className="text-label">
          Hints
        </p>
        {props.hints.length ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {props.revealedHints}/{props.hints.length} used
          </span>
        ) : null}
      </div>
      {!props.hints.length ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          No hints are available for this scenario.
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          {groups.map((group) => (
            <HintLadder
              key={group.key}
              group={group}
              onRevealHint={props.onRevealHint}
              pendingHintKey={props.pendingHintKey}
              hintError={props.hintError}
              failedHintKey={props.failedHintKey}
            />
          ))}
          {props.revealedHints === props.hints.length ? (
            <p className="text-sm leading-6 text-muted-foreground">
              You have used all available hints.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function HintLadder(props: {
  group: HintGroup;
  onRevealHint: (hintKey: string) => void;
  pendingHintKey: string | null;
  hintError: string | null;
  failedHintKey: string | null;
}) {
  const revealed = props.group.hints.filter((hint) => hint.revealed).length;
  // The API exposes exactly one unlocked item per ladder. Keep this UI
  // defensive: even a malformed response cannot offer a later hint first.
  const nextHint = props.group.hints.find((hint) => !hint.revealed);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-label">
          {props.group.label}
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {revealed}/{props.group.hints.length}
        </span>
      </div>
      <ol className="divide-y border-y">
        {props.group.hints.map((hint, index) => {
          const ordinal = `Hint ${index + 1}`;
          const canReveal = nextHint?.key === hint.key && nextHint.unlocked;
          const showError =
            Boolean(props.hintError) &&
            (props.failedHintKey
              ? props.failedHintKey === hint.key
              : canReveal);

          if (hint.revealed) {
            return (
              <li key={hint.key} className="space-y-2 py-4">
                <p className="text-sm font-medium">
                  {hint.title?.trim() || ordinal}
                </p>
                {hint.bodyMarkdown ? (
                  <Markdown className="space-y-2 text-sm leading-6 text-muted-foreground">
                    {hint.bodyMarkdown}
                  </Markdown>
                ) : null}
              </li>
            );
          }

          if (canReveal) {
            return (
              <li key={hint.key} className="py-4">
                <div className="flex min-h-10 items-center justify-between gap-3">
                  {/* Sealed hints expose no authored title or body. */}
                  <p className="text-sm font-medium">{ordinal}</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={props.pendingHintKey === hint.key}
                    onClick={() => props.onRevealHint(hint.key)}
                  >
                    {props.pendingHintKey === hint.key
                      ? "Revealing…"
                      : "Reveal"}
                  </Button>
                </div>
                {showError ? (
                  <p className="mt-2 text-sm leading-6 text-destructive" role="alert">
                    Could not reveal this hint. Try again.
                  </p>
                ) : null}
              </li>
            );
          }

          return (
            <li
              key={hint.key}
              className="flex min-h-10 items-center gap-2.5 py-4 text-muted-foreground"
            >
              <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
              {/* This ordinal is not an authored hint title. */}
              <p className="text-sm">{ordinal}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Solution(props: {
  headingId: string;
  solution: ScenarioRunSolution;
  requiresConfirmation: boolean;
  onRevealSolution: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reveal = () => {
    setConfirmOpen(false);
    props.onRevealSolution();
  };

  return (
    <section
      aria-labelledby={props.headingId}
      className="border-t pt-6"
    >
      <p id={props.headingId} className="text-label">
        Full solution
      </p>
      {props.solution.revealed ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            {props.solution.assisted
              ? "You used the full solution for this run."
              : "This solution unlocked after you completed the scenario."}
          </p>
          {props.solution.bodyMarkdown ? (
            <Markdown className="space-y-2 text-sm leading-6">
              {props.solution.bodyMarkdown}
            </Markdown>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {props.pending ? "Loading solution…" : "Solution unavailable."}
            </p>
          )}
        </div>
      ) : props.solution.unlocked && !props.requiresConfirmation ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm leading-6 text-muted-foreground">
            The full solution is now available.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={props.pending}
            onClick={props.onRevealSolution}
          >
            <Eye className="size-4" aria-hidden="true" />
            {props.pending ? "Loading solution…" : "Show the solution"}
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-sm leading-6 text-muted-foreground">
            Use this when you are ready to see the full fix.
          </p>
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger
              render={
                <Button type="button" variant="outline" disabled={props.pending} />
              }
            >
              <LockKeyhole className="size-4" aria-hidden="true" />
              Reveal the full solution
            </DialogTrigger>
            <DialogContent className="!shadow-none">
              <DialogHeader>
                <DialogTitle>Reveal the full solution?</DialogTitle>
                <DialogDescription>
                  This shows the full fix and marks this run as assisted. Your
                  checks and time stay saved.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmOpen(false)}
                >
                  Keep trying
                </Button>
                <Button type="button" onClick={reveal}>
                  Reveal solution
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
      {props.error ? (
        <p className="mt-2 text-sm leading-6 text-destructive" role="alert">
          Could not reveal the solution. Try again.
        </p>
      ) : null}
    </section>
  );
}

function groupHints(
  hints: readonly ScenarioRunHint[],
  objectives: readonly ScenarioObjective[],
): HintGroup[] {
  const groups: HintGroup[] = [];
  const scenarioHints = hints.filter((hint) => hint.scope === "scenario");
  if (scenarioHints.length) {
    groups.push({
      key: "scenario",
      label: "General guidance",
      hints: scenarioHints,
    });
  }

  const byProbeName = new Map<string, ScenarioRunHint[]>();
  for (const hint of hints) {
    if (hint.scope !== "probe" || !hint.probeName) continue;
    const group = byProbeName.get(hint.probeName) ?? [];
    group.push(hint);
    byProbeName.set(hint.probeName, group);
  }

  const seen = new Set<string>();
  let fallbackIndex = 0;
  for (const objective of objectives) {
    const probeHints = byProbeName.get(objective.probeName);
    if (!probeHints || seen.has(objective.probeName)) continue;
    seen.add(objective.probeName);
    const objectiveIndex = objectives.findIndex(
      (candidate) => candidate.probeName === objective.probeName,
    );
    groups.push({
      key: `probe:${objective.probeName}`,
      label: repairObjectiveTitle(objective, objectiveIndex),
      hints: probeHints,
    });
  }

  for (const [probeName, probeHints] of byProbeName) {
    if (seen.has(probeName)) continue;
    fallbackIndex += 1;
    groups.push({
      key: `probe:${probeName}`,
      label: `Repair guidance ${fallbackIndex}`,
      hints: probeHints,
    });
  }

  return groups;
}

function countPassedChecks(probes: readonly ScenarioProbeStatus[]) {
  return probes.filter((probe) => isVerificationPassed(probe.status)).length;
}

function learnerCheckStatus(status: string): LearnerCheckStatus {
  if (isVerificationPassed(status)) return "verified" as const;
  return ["", "pending", "unknown", "queued", "checking"].includes(
    status.trim().toLowerCase(),
  )
    ? ("checking" as const)
    : ("needs_repair" as const);
}

function learnerCheckStatusLabel(
  status: LearnerCheckStatus,
): LearnerCheck["statusLabel"] {
  if (status === "verified") return "Verified";
  if (status === "checking") return "Checking";
  return "Needs repair";
}

export function getLearnerChecks(
  probes: readonly ScenarioProbeStatus[],
  objectives: readonly ScenarioObjective[],
): LearnerCheck[] {
  return probes.map((probe, index) => {
    const objectiveIndex = objectives.findIndex(
      (candidate) => candidate.probeName === probe.id,
    );
    const objective =
      objectiveIndex >= 0 ? (objectives[objectiveIndex] ?? null) : null;
    const status = learnerCheckStatus(probe.status);
    return {
      key: `${probe.id}:${index}`,
      title: repairObjectiveTitle(
        objective,
        objectiveIndex >= 0 ? objectiveIndex : index,
      ),
      status,
      statusLabel: learnerCheckStatusLabel(status),
    };
  });
}

function countRevealedHints(hints: readonly ScenarioRunHint[]) {
  return hints.filter((hint) => hint.revealed).length;
}

function scopeHintsToVm(
  hints: readonly ScenarioRunHint[],
  vmName: string | null | undefined,
) {
  if (!vmName) return hints;
  return hints.filter((hint) => {
    if (hint.scope === "scenario") return true;
    const parts = hint.key.split(":");
    return parts.length < 4 || parts[1] === vmName;
  });
}

function scopeObjectivesToVm(
  objectives: readonly ScenarioObjective[],
  vmName: string | null | undefined,
) {
  if (!vmName) return objectives;
  const scoped = objectives.filter((objective) => objective.vmName === vmName);
  return scoped.length ? scoped : objectives;
}

function useCheckAnnouncement(input: {
  passedChecks: number;
  totalChecks: number;
}) {
  const previous = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const signature = `${input.passedChecks}/${input.totalChecks}`;

  useEffect(() => {
    if (previous.current !== null && previous.current !== signature) {
      setAnnouncement(
        input.totalChecks && input.passedChecks === input.totalChecks
          ? `All ${input.totalChecks} checks are verified.`
          : `${input.passedChecks} of ${input.totalChecks} checks are verified.`,
      );
    }
    previous.current = signature;
  }, [input.passedChecks, input.totalChecks, signature]);

  return announcement;
}

function useDesktopLearningPanel(initialDesktop: boolean) {
  const [desktop, setDesktop] = useState(initialDesktop);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 960px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return desktop;
}
