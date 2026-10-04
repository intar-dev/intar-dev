import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CheckCircle2,
  CircleDashed,
  Eye,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
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
  SheetClose,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { RunDock } from "./RunDock";
import { RunPhoneSheet } from "./RunPhoneSheet";
import {
  RUN_QUERY,
  useMediaQuery,
  useRunSheet,
  type RunSheetDetent,
  type RunSheetSection,
} from "./run-viewport";
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
import { RollingNumber } from "@/components/app/patterns/RollingNumber";
import { useJustReached } from "@/components/app/patterns/use-just-reached";

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
  /** The run record does not exist yet, so authored checks are still loading. */
  checksPending?: boolean;
  onRevealSolution: () => void;
  solutionPending?: boolean;
  /** A non-empty value means the solution reveal failed. Its text is never rendered. */
  solutionError?: string | null;
  /**
   * The whole run is solved (also true while it saves, archives or deletes).
   * The check bar closes only then, so a multi-machine run does not close per
   * machine. Falls back to `phase === "solved"` when omitted.
   */
  runSolved?: boolean;
  className?: string;
}

export interface RunLearningPanelContentProps
  extends Omit<RunLearningPanelProps, "className"> {
  className?: string;
  /** Rendered at the end of the pinned Checks header row (mobile sheet close). */
  checksAction?: ReactNode;
  /**
   * Leave the segmented bar out of the Checks section. Set it when the same
   * bar is pinned elsewhere (RunCheckBar under the run bar below 960px).
   */
  hideCircuit?: boolean;
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
  const hints = input.totalHints
    ? `${input.revealedHints} of ${input.totalHints} hints revealed`
    : "No hints are available";
  // The accessible name starts with the visible label (WCAG 2.5.3), and an
  // empty list shows no count at all.
  const visibleLabel = input.totalChecks
    ? `Checks ${input.passedChecks}/${input.totalChecks}`
    : "Checks";
  return {
    visibleLabel,
    accessibleLabel: `${visibleLabel}. ${hints}. Opens checks, lecture and hints.`,
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
  const announcement = useCheckAnnouncement(props);

  if (!desktop) return null;

  return (
    <aside
      aria-label="Checks, lecture and hints"
      data-run-learning-panel
      className={cn(
        // Docked under the terminal from 48rem (3:2), beside it from 60rem
        // (2:1). The shell grid decides the split; this only sets the insets.
        "hidden h-full min-h-0 min-w-0 w-full bg-canvas dock:flex dock:flex-col dock:px-3 dock:pb-[max(0.75rem,env(safe-area-inset-bottom))] split:pt-2 split:pr-3 split:pb-3 split:pl-0",
        className,
      )}
    >
      <div
        data-run-learning-panel-scroll
        className="min-h-0 flex-1 scroll-py-4 overflow-y-auto overscroll-contain rounded-xl border bg-card px-4 py-4 shadow-[var(--highlight),var(--shadow-raised)]"
        role="region"
        aria-label="Checks, lecture and hints content"
        tabIndex={0}
      >
        <RunLearningPanelContent {...contentProps} />
      </div>
      <RunLearningPanelAnnouncement announcement={announcement} />
    </aside>
  );
}

/**
 * The run panel on phones: a detent sheet (a side sheet in landscape) that
 * the shell's dock and run bar open through the lifted sheet state. Used on
 * its own, with no shell around it, it brings its own trigger and state. It
 * deliberately has no docked behavior: from 48rem RunLearningPanel is shown.
 */
export function RunLearningPanelMobile(
  props: RunLearningPanelProps & {
    /**
     * The finish block ("All checks verified", Finish and save). While the
     * sheet is open it shows here, above the checks, so a phone that solved
     * the run sees it at peek.
     */
    completion?: ReactNode;
  },
) {
  const { className, completion, ...contentProps } = props;
  const docked = useDesktopLearningPanel(false);
  const shell = useRunSheet();
  const landscape = useMediaQuery(RUN_QUERY.short);
  const [localOpen, setLocalOpen] = useState(false);
  const [localDetent, setLocalDetent] = useState<RunSheetDetent>("peek");
  const localOpenerRef = useRef<HTMLElement | null>(null);
  const open = shell ? shell.open : localOpen;
  const detent = shell ? shell.detent : localDetent;
  const openerRef = shell ? shell.openerRef : localOpenerRef;
  const wasOpenRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const passedChecks = countPassedChecks(props.probes);
  const hints = useMemo(
    () => scopeHintsToVm(props.hints, props.vmName),
    [props.hints, props.vmName],
  );
  const copy = props.checksPending
    ? {
        visibleLabel: "Checks loading",
        accessibleLabel: "Checks loading. Opens checks, lecture and hints.",
      }
    : getRunLearningTriggerCopy({
        passedChecks,
        totalChecks: props.probes.length,
        revealedHints: countRevealedHints(hints),
        totalHints: hints.length,
      });
  // The visible count rolls when a check verifies; the accessible name above
  // already carries the same words as plain text.
  const visibleLabel: ReactNode =
    props.checksPending || props.probes.length === 0 ? (
      copy.visibleLabel
    ) : (
      <>
        Checks <RollingNumber value={passedChecks} />/{props.probes.length}
      </>
    );
  const announcement = useCheckAnnouncement(props);

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
  }, [open, openerRef]);

  // Opening on lecture or hints brings that section to the top.
  const section = shell?.section ?? "checks";
  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() =>
      scrollSheetToSection(section),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open, section]);

  const closeSheet = shell?.closeSheet;
  useEffect(() => {
    if (docked) {
      restoreFocusRef.current = false;
      localOpenerRef.current = null;
      wasOpenRef.current = false;
      setLocalOpen(false);
      closeSheet?.();
    }
  }, [docked, closeSheet]);

  const rememberOpener = (event: ReactMouseEvent<HTMLElement>) => {
    localOpenerRef.current = event.currentTarget;
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && window.matchMedia(RUN_QUERY.docked).matches) {
      restoreFocusRef.current = false;
      setLocalOpen(false);
      return;
    }
    if (nextOpen) restoreFocusRef.current = true;
    if (shell) {
      if (!nextOpen) shell.closeSheet();
      return;
    }
    setLocalOpen(nextOpen);
  };
  const handleDetentChange = (next: RunSheetDetent) => {
    if (shell) shell.setDetent(next);
    else setLocalDetent(next);
  };

  if (docked) return null;

  return (
    <div data-run-learning-mobile className={cn("dock:hidden", className)}>
      {shell ? (
        <RunDock
          checksLabel={visibleLabel}
          checksAccessibleLabel={copy.accessibleLabel}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 px-3 pointer-coarse:min-h-11"
          aria-label={copy.accessibleLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-run-learning-panel-trigger
          onClick={(event) => {
            rememberOpener(event);
            handleOpenChange(true);
          }}
        >
          <ListChecks className="size-4" aria-hidden="true" />
          {visibleLabel}
        </Button>
      )}
      <RunPhoneSheet
        open={open}
        onOpenChange={handleOpenChange}
        detent={detent}
        onDetentChange={handleDetentChange}
        side={landscape ? "right" : "bottom"}
        header={<LearningPanelA11yHeader />}
      >
        {completion ? <div className="mb-3">{completion}</div> : null}
        <RunLearningPanelContent
          {...contentProps}
          checksAction={<LearningPanelClose />}
          // With the shell around, the same bar is pinned under the run bar.
          {...(shell ? { hideCircuit: true } : {})}
        />
      </RunPhoneSheet>
      <RunLearningPanelAnnouncement announcement={announcement} />
    </div>
  );
}

/** Scrolls the sheet's body so the named section sits under the pinned checks. */
function scrollSheetToSection(section: RunSheetSection) {
  const scroller = document.querySelector<HTMLElement>(
    "[data-run-learning-mobile-scroll]",
  );
  if (!scroller) return;
  if (section === "checks") {
    scroller.scrollTop = 0;
    return;
  }
  const prefix = section === "lecture" ? "Lecture" : "Hints";
  const target = [
    ...scroller.querySelectorAll<HTMLElement>("section[aria-labelledby]"),
  ].find((candidate) =>
    document
      .getElementById(candidate.getAttribute("aria-labelledby") ?? "")
      ?.textContent?.startsWith(prefix),
  );
  if (!target) return;
  const pinned =
    scroller.querySelector<HTMLElement>("[data-run-pinned-checks]")
      ?.offsetHeight ?? 0;
  scroller.scrollTop +=
    target.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    pinned;
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
      className={cn("space-y-5 bg-card pb-6", props.className)}
    >
      {/* Both scroll containers have 1rem top padding; pin over it so text
          never scrolls through the band above the checks. */}
      <div
        className="sticky -top-4 z-20 -mx-1 -mt-4 isolate bg-card px-1 pt-4 pb-3"
        data-run-pinned-checks
      >
        {/* Keyed by machine: a switch renders the other machine's checks as a
            view change (no roll, flash or close), not as a transition. */}
        <Checks
          key={props.vmName ?? ""}
          headingId={checksHeadingId}
          probes={props.probes}
          objectives={objectives}
          passedChecks={passedChecks}
          solved={props.runSolved ?? state === "solved"}
          hideCircuit={props.hideCircuit === true}
          pending={props.checksPending === true}
          pinned
          action={props.checksAction}
        />
      </div>

      <LectureTheory
        headingId={theoryHeadingId}
        briefingMarkdown={props.briefingMarkdown}
        lectureMarkdown={props.lectureMarkdown}
        lectureTitle={props.lectureTitle}
      />

      {!props.checksPending ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

function LearningPanelA11yHeader() {
  return (
    <SheetHeader className="sr-only">
      <SheetTitle>Checks, lecture and hints</SheetTitle>
      <SheetDescription>
        Your checks, lecture theory, hints, and solution.
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
          size="icon-sm"
          className="-my-1.5 -mr-1.5"
          aria-label="Close checks, lecture and hints"
        />
      }
    >
      <X className="size-4" aria-hidden="true" />
    </SheetClose>
  );
}

// Needs repair is an open task, not an error: a dashed amber ring. Checking
// spins in the informational blue. Verified settles into a green check that
// pops only at the moment it turns, never on first paint.
// All three icons share one grid cell ([data-swap] in global.css), so the
// outgoing one fades while the incoming one rises in.
function CheckStatusIcon({
  status,
  justVerified = false,
}: {
  status: LearnerCheckStatus;
  justVerified?: boolean;
}) {
  const on = (name: LearnerCheckStatus) =>
    status === name ? true : undefined;
  return (
    <span data-swap="center" aria-hidden="true" className="mt-1">
      <CircleDashed
        data-on={on("needs_repair")}
        className="size-4 text-warning"
      />
      <LoaderCircle
        data-on={on("checking")}
        className={cn(
          "size-4 text-info",
          status === "checking" && "motion-safe:animate-spin",
        )}
      />
      <CheckCircle2
        data-on={on("verified")}
        className={cn(
          "size-4 text-success",
          status === "verified" && justVerified && "animate-pop",
        )}
      />
    </span>
  );
}

/** The status word: every word stacked, so the box keeps the widest one. */
function CheckStatusWord({ status }: { status: LearnerCheckStatus }) {
  return (
    <span
      data-swap="end"
      className="text-xs leading-6 font-medium whitespace-nowrap"
    >
      {(["needs_repair", "checking", "verified"] as const).map((name) => (
        <span
          key={name}
          data-on={status === name ? true : undefined}
          className={CHECK_LABEL_TONES[name]}
        >
          {learnerCheckStatusLabel(name)}
        </span>
      ))}
    </span>
  );
}

const CHECK_SEGMENT_TONES: Record<LearnerCheckStatus, string> = {
  verified: "bg-success",
  checking: "bg-info/60",
  needs_repair: "bg-border-strong/70",
};

/**
 * The segmented bar. Closing (gap 4px to 0, inner corners squared) and the one
 * current along the line live in global.css under `[data-checks-bar]`.
 */
export function CheckCircuit({
  checks,
  closed = false,
  current = false,
  className,
}: {
  checks: readonly LearnerCheck[];
  closed?: boolean;
  current?: boolean;
  className?: string;
}) {
  if (!checks.length) return null;
  return (
    <span
      aria-hidden="true"
      data-checks-bar
      data-closed={closed || undefined}
      data-current={current || undefined}
      className={cn("relative mt-3 flex shrink-0 gap-1", className)}
    >
      {checks.map((check) => (
        <span
          key={check.key}
          className={cn("h-1 flex-1", CHECK_SEGMENT_TONES[check.status])}
        />
      ))}
    </span>
  );
}

// ponytail: the 350ms beat between the last verify and the close is a
// literal; the CSS durations read their tokens.
const CIRCUIT_CLOSE_DELAY_MS = 350;

/**
 * 350ms after the whole run is solved the circuit closes, and a current runs
 * once. A run that loads solved starts closed, without the current.
 */
function useCircuitClosed(shouldClose: boolean) {
  const [closed, setClosed] = useState(shouldClose);
  const [current, setCurrent] = useState(false);

  useEffect(() => {
    if (!shouldClose) {
      setClosed(false);
      setCurrent(false);
      return undefined;
    }
    if (closed) return undefined;
    const timer = window.setTimeout(() => {
      setClosed(true);
      setCurrent(true);
    }, CIRCUIT_CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [shouldClose, closed]);

  return { closed, current };
}

function scopedChecks(
  probes: readonly ScenarioProbeStatus[],
  objectives: readonly ScenarioObjective[],
  vmName: string | null | undefined,
) {
  return getLearnerChecks(probes, scopeObjectivesToVm(objectives, vmName));
}

function isRunSolved(
  props: Pick<RunLearningPanelProps, "runSolved" | "phase">,
) {
  return props.runSolved ?? props.phase === "solved";
}

/**
 * The same segmented bar, pinned outside the panel: place it directly under
 * the run bar below 960px (aria-hidden, so the status region does not
 * double-announce). Pass `hideCircuit` to the panel content when you do.
 */
export function RunCheckBar(
  props: Pick<
    RunLearningPanelProps,
    "probes" | "objectives" | "vmName" | "phase" | "runSolved" | "className"
  >,
) {
  const checks = useMemo(
    () => scopedChecks(props.probes, props.objectives, props.vmName),
    [props.probes, props.objectives, props.vmName],
  );
  const solved =
    isRunSolved(props) &&
    checks.length > 0 &&
    checks.every((check) => check.status === "verified");
  // Remount per machine so a switch renders the bar still.
  return (
    <PinnedCheckBar
      key={props.vmName ?? ""}
      checks={checks}
      solved={solved}
      className={props.className}
    />
  );
}

function PinnedCheckBar(props: {
  checks: readonly LearnerCheck[];
  solved: boolean;
  className?: string | undefined;
}) {
  const { closed, current } = useCircuitClosed(props.solved);
  return (
    <CheckCircuit
      checks={props.checks}
      closed={closed}
      current={current}
      className={cn("mt-0", props.className)}
    />
  );
}

const CHECK_TOAST_ENTER_MS = 200;
const CHECK_TOAST_HOLD_MS = 2400;
const CHECK_TOAST_EXIT_MS = 150;

/**
 * Below 960px, a check that verifies while the panel is hidden drops in as a
 * pill for `--duration-hold`, then fades. aria-hidden: the status region
 * already announces the check. Render it inside a `relative` container
 * directly under the run bar and pass `active` while the panel is closed.
 */
export function RunCheckToast(
  props: Pick<
    RunLearningPanelProps,
    "probes" | "objectives" | "vmName" | "className"
  > & { active: boolean },
) {
  const scope = props.vmName ?? "";
  const checks = useMemo(
    () => scopedChecks(props.probes, props.objectives, props.vmName),
    [props.probes, props.objectives, props.vmName],
  );
  const reached = useJustReached(
    checks.map((check) => [`${scope}|${check.key}`, check.status] as const),
    "verified",
  );
  const seen = useRef<ReadonlySet<string>>(new Set());
  const timers = useRef<number[]>([]);
  const [toast, setToast] = useState<{
    id: number;
    title: string;
    leaving: boolean;
  } | null>(null);

  const clearTimers = () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  };

  useEffect(() => {
    const fresh = checks.filter((check) => {
      const id = `${scope}|${check.key}`;
      return reached.has(id) && !seen.current.has(id);
    });
    seen.current = reached;
    const latest = fresh[fresh.length - 1];
    if (!latest || !props.active) return;
    clearTimers();
    setToast((previous) => ({
      id: (previous?.id ?? 0) + 1,
      title: latest.title,
      leaving: false,
    }));
    timers.current = [
      window.setTimeout(
        () => setToast((value) => (value ? { ...value, leaving: true } : value)),
        CHECK_TOAST_ENTER_MS + CHECK_TOAST_HOLD_MS,
      ),
      window.setTimeout(
        () => setToast(null),
        CHECK_TOAST_ENTER_MS + CHECK_TOAST_HOLD_MS + CHECK_TOAST_EXIT_MS,
      ),
    ];
    // `reached` is a stable set that changes only on a real transition.
  }, [reached]);

  // Opening the panel puts the checks in view, so the toast has nothing to add.
  useEffect(() => {
    if (props.active) return;
    clearTimers();
    setToast(null);
  }, [props.active]);

  useEffect(() => clearTimers, []);

  if (!toast) return null;
  return (
    <div
      aria-hidden="true"
      data-run-check-toast
      data-leaving={toast.leaving || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-full z-30 mt-2 flex justify-center px-4",
        props.className,
      )}
    >
      <span
        key={toast.id}
        className="check-toast inline-flex max-w-full items-center gap-2 rounded-full border border-success-border bg-success-subtle px-3 py-1.5 text-[0.8125rem] leading-5 font-medium text-foreground shadow-(--shadow-raised)"
      >
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
        <span className="truncate">{toast.title}</span>
      </span>
    </div>
  );
}

const CHECK_LABEL_TONES: Record<LearnerCheckStatus, string> = {
  verified: "text-success",
  checking: "text-info",
  needs_repair: "text-warning",
};

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
          className="mt-3 space-y-3 text-support"
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
      <p id={props.headingId} className="text-label">
        Work order
      </p>
      {props.objectives.length ? (
        <ol className="mt-3 divide-y border-y">
          {props.objectives.map((objective, index) => (
            <li
              key={`${objective.probeName}:${index}`}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-3"
            >
              <span className="text-sm font-semibold text-faint-foreground tabular-nums">
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
  solved: boolean;
  hideCircuit: boolean;
  pending?: boolean;
  pinned?: boolean;
  action?: ReactNode;
}) {
  const checks = getLearnerChecks(props.probes, props.objectives);
  const justVerified = useJustReached(
    checks.map((check) => [check.key, check.status] as const),
    "verified",
  );
  const { closed, current } = useCircuitClosed(
    props.solved &&
      checks.length > 0 &&
      checks.every((check) => check.status === "verified"),
  );

  return (
    <section
      aria-labelledby={props.headingId}
      aria-busy={props.pending || undefined}
      className={cn(
        props.pinned &&
          "flex max-h-[min(44dvh,24rem)] min-h-0 flex-col bg-card",
      )}
    >
      <div className="flex shrink-0 items-center gap-3">
        <p id={props.headingId} className="min-w-0 flex-1 text-label">
          Checks
        </p>
        {!props.pending && checks.length ? (
          <span className="shrink-0 text-metadata">
            <RollingNumber value={props.passedChecks} />/{checks.length} verified
          </span>
        ) : null}
        {props.action}
      </div>
      {props.hideCircuit ? null : (
        <CheckCircuit checks={checks} closed={closed} current={current} />
      )}
      {checks.length ? (
        <ol
          tabIndex={props.pinned ? 0 : undefined}
          aria-label={props.pinned ? "Checks list" : undefined}
          className={cn(
            "-mx-2 mt-3 space-y-0.5",
            props.pinned &&
              "min-h-0 overflow-y-auto overscroll-contain border-b pb-2",
          )}
        >
          {checks.map((check) => {
            return (
              <li
                key={check.key}
                data-check-status={check.status}
                className={cn(
                  "grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-3 rounded-lg px-2 py-2",
                  justVerified.has(check.key) && "animate-verified",
                )}
              >
                <CheckStatusIcon
                  status={check.status}
                  justVerified={justVerified.has(check.key)}
                />
                <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 text-sm font-medium leading-6 [overflow-wrap:anywhere]">
                    {check.title}
                  </span>
                  <CheckStatusWord status={check.status} />
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p
          role={props.pending ? "status" : undefined}
          className="mt-3 text-sm leading-6 text-muted-foreground"
        >
          {props.pending
            ? "Checks will appear when the run is created."
            : "No checks are available yet."}
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
  // Only a hint revealed while this is mounted unfolds, rises and takes focus;
  // hints revealed on load (or after a machine switch) render still.
  const justRevealed = useJustReached(
    props.hints.map(
      (hint) => [hint.key, hint.revealed ? "revealed" : "sealed"] as const,
    ),
    "revealed",
  );
  const bodies = useRef(new Map<string, HTMLElement>());
  const newest = [...justRevealed].pop();

  useEffect(() => {
    if (!newest) return;
    const body = bodies.current.get(newest);
    if (!body) return;
    // The Reveal button that held focus is gone: land on the hint's body, but
    // never steal focus the learner moved elsewhere.
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      body.closest("li")?.contains(active)
    ) {
      body.focus({ preventScroll: true });
    }
  }, [newest]);

  let announcement = "";
  if (newest) {
    for (const group of groups) {
      const index = group.hints.findIndex((hint) => hint.key === newest);
      if (index < 0) continue;
      const ordinal = `Hint ${index + 1}`;
      announcement = `${ordinal} revealed: ${
        group.hints[index]?.title?.trim() || ordinal
      }`;
    }
  }

  return (
    <section aria-labelledby={props.headingId}>
      <div className="flex items-center justify-between gap-3">
        <p id={props.headingId} className="text-label">
          Hints
        </p>
        {props.hints.length ? (
          <span className="text-metadata">
            <RollingNumber value={props.revealedHints} />/{props.hints.length}{" "}
            used
          </span>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {!props.hints.length ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          No hints are available for this scenario.
        </p>
      ) : (
        <>
          {/* One ladder sits right under the head; several each get a label. */}
          <div className={cn("space-y-4", groups.length > 1 ? "mt-4" : "mt-3")}>
            {groups.map((group) => (
              <HintLadder
                key={group.key}
                group={group}
                headingId={props.headingId}
                showHeader={groups.length > 1}
                justRevealed={justRevealed}
                bodies={bodies}
                onRevealHint={props.onRevealHint}
                pendingHintKey={props.pendingHintKey}
                hintError={props.hintError}
                failedHintKey={props.failedHintKey}
              />
            ))}
          </div>
          {props.revealedHints === props.hints.length ? (
            <p
              className={cn(
                "mt-3 text-sm leading-6 text-muted-foreground",
                justRevealed.size > 0 && "animate-rise",
              )}
            >
              You have used all available hints.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function HintLadder(props: {
  group: HintGroup;
  headingId: string;
  showHeader: boolean;
  justRevealed: ReadonlySet<string>;
  bodies: RefObject<Map<string, HTMLElement>>;
  onRevealHint: (hintKey: string) => void;
  pendingHintKey: string | null;
  hintError: string | null;
  failedHintKey: string | null;
}) {
  const labelId = useId();
  const revealed = props.group.hints.filter((hint) => hint.revealed).length;
  // The API exposes exactly one unlocked item per ladder. Keep this UI
  // defensive: even a malformed response cannot offer a later hint first.
  const nextHint = props.group.hints.find((hint) => !hint.revealed);

  return (
    <div className="space-y-3">
      {props.showHeader ? (
        <div className="flex items-baseline justify-between gap-3">
          <p id={labelId} className="text-label">
            {props.group.label}
          </p>
          <span className="text-metadata">
            <RollingNumber value={revealed} />/{props.group.hints.length}
          </span>
        </div>
      ) : null}
      <ol
        aria-labelledby={props.showHeader ? labelId : props.headingId}
        className="divide-y overflow-hidden rounded-lg border bg-muted/30 dark:bg-background/40"
      >
        {props.group.hints.map((hint, index) => {
          const ordinal = `Hint ${index + 1}`;
          const ordinalId = `${labelId}-${index}`;
          const canReveal = nextHint?.key === hint.key && nextHint.unlocked;
          const pending = props.pendingHintKey === hint.key;
          const just = props.justRevealed.has(hint.key);
          const locked = !hint.revealed && !canReveal;
          const showError =
            Boolean(props.hintError) &&
            (props.failedHintKey
              ? props.failedHintKey === hint.key
              : canReveal);
          const bodyRefs = props.bodies;

          // One stable row holds two folds: the sealed row (ordinal, lock and
          // Reveal) folds away on reveal while the hint body unfolds. A hint
          // that loads revealed never mounts its sealed row.
          return (
            <li key={hint.key} data-hint-state={locked ? "locked" : hint.revealed ? "revealed" : "ready"}>
              {!hint.revealed || just ? (
                <div
                  inert={hint.revealed}
                  className={cn(
                    "grid transition-[grid-template-rows] duration-(--duration-slow) ease-enter",
                    hint.revealed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
                  )}
                >
                  <div
                    className={cn(
                      "min-h-0 overflow-hidden",
                      hint.revealed &&
                        "invisible [transition:visibility_0s_linear_var(--duration-slow)]",
                    )}
                  >
                    <div
                      className={cn(
                        "px-3 py-2 transition-opacity duration-(--duration-fast) ease-exit",
                        hint.revealed && "opacity-0",
                      )}
                    >
                      <div className="flex min-h-9 items-center justify-between gap-3">
                        {/* Sealed hints expose no authored title or body. */}
                        <p
                          className={cn(
                            "inline-flex items-center text-sm transition-colors duration-(--duration-fast) ease-standard",
                            locked
                              ? "font-normal text-faint-foreground"
                              : "font-medium text-foreground",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "inline-grid transition-[grid-template-columns,opacity] duration-(--duration-slow) ease-enter",
                              locked
                                ? "grid-cols-[1fr] opacity-100"
                                : "grid-cols-[0fr] opacity-0 delay-200",
                            )}
                          >
                            <span className="min-w-0 overflow-hidden">
                              <LockKeyhole className="mr-2 block size-4" />
                            </span>
                          </span>
                          {/* This ordinal is not an authored hint title. */}
                          <span id={ordinalId}>{ordinal}</span>
                        </p>
                        <span
                          className={cn(
                            "transition-[opacity,visibility] duration-(--duration-moderate) ease-enter",
                            canReveal ? "delay-200" : "invisible opacity-0",
                          )}
                        >
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!canReveal || pending}
                            focusableWhenDisabled
                            aria-busy={pending || undefined}
                            aria-describedby={
                              props.showHeader
                                ? `${ordinalId} ${labelId}`
                                : ordinalId
                            }
                            onClick={() => props.onRevealHint(hint.key)}
                          >
                            <AsyncLabel
                              state={pending ? "pending" : "idle"}
                              idle={
                                <>
                                  <Eye className="size-3.5" aria-hidden="true" />
                                  Reveal
                                </>
                              }
                              pending="Revealing…"
                            />
                          </Button>
                        </span>
                      </div>
                      {showError ? (
                        <InlineFeedback tone="error" className="mt-2">
                          Could not reveal this hint.
                        </InlineFeedback>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
              {hint.revealed ? (
                <div className="hint-unfold" data-just={just || undefined}>
                  <div className="min-h-0 overflow-hidden">
                    <div
                      ref={(node) => {
                        if (node) bodyRefs.current.set(hint.key, node);
                        else bodyRefs.current.delete(hint.key);
                      }}
                      tabIndex={-1}
                      className={cn(
                        "space-y-2 px-3 py-3 focus-visible:-outline-offset-2",
                        just && "animate-rise",
                      )}
                    >
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <Lightbulb
                          className="size-3.5 shrink-0 text-warning"
                          aria-hidden="true"
                        />
                        {hint.title?.trim() || ordinal}
                      </p>
                      {hint.bodyMarkdown ? (
                        <Markdown className="space-y-2 text-sm leading-6 text-muted-foreground">
                          {hint.bodyMarkdown}
                        </Markdown>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
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
  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Like a hint, only a solution revealed while mounted takes focus, rises
  // and is announced; one that loads revealed renders still.
  const just = useJustReached(
    [["solution", props.solution.revealed ? "revealed" : "sealed"]],
    "revealed",
  ).has("solution");
  const reveal = () => {
    setConfirmOpen(false);
    props.onRevealSolution();
  };

  useEffect(() => {
    if (!just) return;
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      sectionRef.current?.contains(active)
    ) {
      bodyRef.current?.focus({ preventScroll: true });
    }
  }, [just]);

  return (
    <section
      ref={sectionRef}
      aria-labelledby={props.headingId}
      className="border-t pt-5"
    >
      <p id={props.headingId} className="text-label">
        Full solution
      </p>
      <p role="status" className="sr-only">
        {just ? "Full solution revealed." : ""}
      </p>
      {props.solution.revealed ? (
        <div
          ref={bodyRef}
          tabIndex={-1}
          className={cn(
            "mt-3 space-y-3 focus-visible:outline-offset-4",
            just && "animate-rise",
          )}
        >
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
            focusableWhenDisabled
            aria-busy={props.pending || undefined}
            onClick={props.onRevealSolution}
          >
            <AsyncLabel
              state={props.pending ? "pending" : "idle"}
              idle={
                <>
                  <Eye className="size-4" aria-hidden="true" />
                  Show the solution
                </>
              }
              pending="Loading solution…"
            />
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
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.pending}
                  focusableWhenDisabled
                  aria-busy={props.pending || undefined}
                />
              }
            >
              <AsyncLabel
                state={props.pending ? "pending" : "idle"}
                idle={
                  <>
                    <LockKeyhole className="size-4" aria-hidden="true" />
                    Reveal the full solution
                  </>
                }
                pending="Revealing…"
              />
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reveal the full solution?</DialogTitle>
                <DialogDescription>
                  This shows the full fix, marks this run as assisted, and
                  keeps your checks and time.
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
        <InlineFeedback tone="error" className="mt-2">
          Could not reveal the solution.
        </InlineFeedback>
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

// ponytail: the beat between the last check and the completion bar
// (RunCompletionBar) is a literal; keep the two in step.
const ALL_VERIFIED_ANNOUNCE_MS = 650;

/**
 * Names each check as it verifies ("<title> verified") and, 650ms after the
 * run is solved, says "All checks verified". Nothing is said on load, on a
 * machine switch or when a check drops back: only a real transition speaks.
 */
function useCheckAnnouncement(
  input: Pick<
    RunLearningPanelProps,
    "probes" | "objectives" | "vmName" | "phase" | "runSolved"
  >,
) {
  const scope = input.vmName ?? "";
  const checks = useMemo(
    () => scopedChecks(input.probes, input.objectives, input.vmName),
    [input.probes, input.objectives, input.vmName],
  );
  // Ids carry the machine, so another machine's checks are new, not reached.
  const reached = useJustReached(
    checks.map((check) => [`${scope}|${check.key}`, check.status] as const),
    "verified",
  );
  const solvedNow = useJustReached(
    [["run", isRunSolved(input) ? "solved" : "open"]],
    "solved",
  ).has("run");
  const announced = useRef<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const fresh = checks.filter((check) => {
      const id = `${scope}|${check.key}`;
      return reached.has(id) && !announced.current.has(id);
    });
    announced.current = reached;
    if (fresh.length) {
      setAnnouncement(fresh.map((check) => `${check.title} verified`).join(". "));
    }
    // `reached` changes only on a real transition.
  }, [reached]);

  useEffect(() => {
    if (!solvedNow) return undefined;
    const timer = window.setTimeout(
      () => setAnnouncement("All checks verified"),
      ALL_VERIFIED_ANNOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [solvedNow]);

  return announcement;
}

function useDesktopLearningPanel(initialDesktop: boolean) {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(RUN_QUERY.docked).matches
      : initialDesktop,
  );

  useEffect(() => {
    const media = window.matchMedia(RUN_QUERY.docked);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return desktop;
}
