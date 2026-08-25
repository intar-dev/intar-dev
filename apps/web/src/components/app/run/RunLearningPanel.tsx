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
  ListChecks,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  /** Present only while a solved lab can be saved and shut down. */
  onFinishAndSave?: (() => void) | undefined;
  finishPending?: boolean;
  finishError?: boolean;
  className?: string;
}

export interface RunLearningPanelContentProps
  extends Omit<RunLearningPanelProps, "className"> {
  className?: string;
  /** Desktop check circles replace the repeated list; mobile keeps the list. */
  showCheckList?: boolean;
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

/**
 * The app bar should never leak a run's internal phase title. These are the
 * only learner-facing states it needs to name.
 */
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
    visibleLabel: input.totalHints
      ? `Hints ${input.revealedHints}/${input.totalHints}`
      : "Guidance",
    accessibleLabel: `Open lab guidance. ${hints}. ${checks}.`,
  };
}

/**
 * Shared learner guidance for the app bar. Compact check circles stay visible
 * while desktop and tablet guidance slides in as a narrow right rail. Phones
 * retain the bottom sheet. The content stays shared so polling cannot make the
 * two experiences drift apart.
 */
export function RunLearningPanel(props: RunLearningPanelProps) {
  const compact = useCompactLearningPanel();
  const expandedChecks = useExpandedCheckIndicators();
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const passedChecks = countPassedChecks(props.probes);
  const hints = useMemo(
    () => scopeHintsToVm(props.hints, props.vmName),
    [props.hints, props.vmName],
  );
  const objectives = useMemo(
    () => scopeObjectivesToVm(props.objectives, props.vmName),
    [props.objectives, props.vmName],
  );
  const revealedHints = countRevealedHints(hints);
  const copy = getRunLearningTriggerCopy({
    passedChecks,
    totalChecks: props.probes.length,
    revealedHints,
    totalHints: hints.length,
  });
  const announcement = useCheckAnnouncement({
    passedChecks,
    totalChecks: props.probes.length,
  });

  useEffect(() => {
    if (wasOpenRef.current && !open) {
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

  const rememberOpener = (event: ReactMouseEvent<HTMLElement>) => {
    openerRef.current = event.currentTarget;
  };
  const openFromCheck = (event: ReactMouseEvent<HTMLButtonElement>) => {
    rememberOpener(event);
    setOpen(true);
  };
  const trigger = renderRunLearningPanelTrigger({
    copy,
    probes: props.probes,
    showCompactChecks: !expandedChecks,
    onOpen: rememberOpener,
  });
  const content = (
    <RunLearningPanelContent
      {...props}
      hints={hints}
      showCheckList={!expandedChecks}
    />
  );

  return (
    <>
      <div
        data-run-learning-chrome
        className="flex h-11 shrink-0 items-center gap-1"
      >
        <CheckIndicatorRow
          probes={props.probes}
          objectives={objectives}
          expanded={expandedChecks}
          onOpen={openFromCheck}
        />
        {compact ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={trigger} />
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="max-h-[min(78dvh,42rem)] rounded-t-2xl border-x border-t pb-[max(1rem,env(safe-area-inset-bottom))] motion-reduce:transition-none"
            >
              <LearningPanelA11yHeader />
              <LearningPanelClose />
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
                {content}
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <Sheet
            open={open}
            onOpenChange={setOpen}
            modal={false}
            disablePointerDismissal
          >
            <SheetTrigger render={trigger} />
            <SheetContent
              side="right"
              showCloseButton={false}
              showOverlay={false}
              style={{
                top: "var(--app-bar-h)",
                height: "calc(100dvh - var(--app-bar-h))",
              }}
              className="w-[min(22rem,calc(100vw-1rem))] border-l shadow-xl duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            >
              <LearningPanelA11yHeader />
              <LearningPanelClose />
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
                {content}
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

/**
 * The interior is exported separately for focused SSR tests and to guarantee
 * the popover and the sheet present exactly the same learning flow.
 */
export function RunLearningPanelContent(props: RunLearningPanelContentProps) {
  const headingId = useId();
  const learningStartRef = useRef<HTMLDivElement>(null);
  const state = getRunLearningPanelState(props.phase);
  const showCheckList = props.showCheckList ?? true;
  const showWorkOrderOrChecks = state === "booting" || showCheckList;
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

  return (
    <div
      data-run-learning-panel-content
      className={cn("space-y-6 pb-2", props.className)}
    >
      {showWorkOrderOrChecks ? (
        <button
          type="button"
          data-run-learning-sticky-summary
          className="sticky top-0 z-20 -mx-4 flex min-h-11 w-[calc(100%+2rem)] items-center justify-between gap-3 border-b bg-popover py-2 pr-14 pl-4 text-sm font-semibold shadow-[0_1px_0_var(--border)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/40"
          aria-label={`${state === "booting" ? "Show work order" : "Show checks"}. ${passedChecks} of ${props.probes.length} verified.`}
          onClick={() =>
            learningStartRef.current?.scrollIntoView({ block: "start" })
          }
        >
          <span className="inline-flex items-center gap-2">
            <ListChecks className="size-4 text-primary" aria-hidden="true" />
            {state === "booting"
              ? "Work order"
              : state === "solved"
                ? "Solved"
                : "Checks"}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {passedChecks}/{props.probes.length}
          </span>
        </button>
      ) : null}

      <header className="pr-12">
        <p className="text-eyebrow">Lab guidance</p>
        <h2 id={headingId} className="mt-1 font-heading text-lg font-semibold">
          {panelHeading(state, showCheckList)}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {panelSummary({
            state,
            passedChecks,
            totalChecks: props.probes.length,
            showCheckList,
          })}
        </p>
      </header>

      {state === "solved" && props.onFinishAndSave ? (
        <section aria-label="Finish lab">
          <Button
            className="w-full bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success"
            disabled={props.finishPending}
            onClick={props.onFinishAndSave}
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {props.finishPending ? "Saving your run…" : "Finish and save"}
          </Button>
          {props.finishError ? (
            <p className="mt-2 text-sm leading-6 text-destructive" role="alert">
              We could not save this run. Your work is still open. Try again.
            </p>
          ) : null}
        </section>
      ) : null}

      {showWorkOrderOrChecks ? (
        <div ref={learningStartRef} className="scroll-mt-12">
          {state === "booting" ? (
            <WorkOrder objectives={objectives} />
          ) : (
            <Checks
              probes={props.probes}
              objectives={objectives}
              passedChecks={passedChecks}
            />
          )}
        </div>
      ) : null}

      <Hints
        hints={hints}
        objectives={objectives}
        onRevealHint={props.onRevealHint}
        pendingHintKey={props.pendingHintKey ?? null}
        hintError={props.hintError ?? null}
        failedHintKey={props.failedHintKey ?? null}
        revealedHints={revealedHints}
      />

      <Solution
        solution={props.solution}
        requiresConfirmation={state !== "solved"}
        onRevealSolution={props.onRevealSolution}
        pending={props.solutionPending ?? false}
        error={props.solutionError ?? null}
      />
    </div>
  );
}

function renderRunLearningPanelTrigger(props: {
  copy: RunLearningTriggerCopy;
  probes: readonly ScenarioProbeStatus[];
  showCompactChecks: boolean;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="default"
      className="gap-1.5 px-2 md:px-3"
      aria-label={props.copy.accessibleLabel}
      data-run-learning-panel-trigger
      onClick={props.onOpen}
    >
      <CompactCheckDots
        probes={props.probes}
        show={props.showCompactChecks}
      />
      <Lightbulb className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">{props.copy.visibleLabel}</span>
    </Button>
  );
}

function LearningPanelA11yHeader() {
  return (
    <SheetHeader className="sr-only">
      <SheetTitle>Lab guidance</SheetTitle>
      <SheetDescription>Your checks, hints, and solution.</SheetDescription>
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
          className="absolute top-2 right-2 z-30"
          aria-label="Close lab guidance"
        />
      }
    >
      <X className="size-4" aria-hidden="true" />
    </SheetClose>
  );
}

function CheckIndicatorRow(props: {
  probes: readonly ScenarioProbeStatus[];
  objectives: readonly ScenarioObjective[];
  expanded: boolean;
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const checks = getLearnerChecks(props.probes, props.objectives);
  const passedChecks = checks.filter(
    (check) => check.status === "verified",
  ).length;

  if (!checks.length) return null;

  return (
    <div
      role="group"
      aria-label={`${passedChecks} of ${checks.length} checks verified`}
      data-run-check-indicators
      className={cn("h-11 items-center", props.expanded ? "flex" : "hidden")}
    >
      <div
        className={cn(
          "flex items-center",
          checks.length > 5 &&
            "max-w-36 overflow-x-auto overscroll-x-contain [scrollbar-width:none] lg:max-w-56 xl:max-w-[22rem] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {checks.map((check) => {
          return (
            <Tooltip key={check.key}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Open lab guidance. ${check.title}. ${check.statusLabel}.`}
                    aria-haspopup="dialog"
                    data-run-check-indicator
                    data-status={check.status}
                    className="rounded-full"
                    onClick={props.onOpen}
                  >
                    <CheckStatusIcon status={check.status} />
                  </Button>
                }
              />
              <TooltipContent
                side="bottom"
                sideOffset={6}
                className="max-w-64 motion-reduce:animate-none"
                data-run-check-tooltip
              >
                <span className="font-semibold">{check.title}</span>
                <span aria-hidden="true">·</span>
                <span>{check.statusLabel}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {checks.length > 5 ? (
        <span
          data-run-check-overflow
          className="ml-1 text-xs text-muted-foreground tabular-nums xl:hidden"
          aria-hidden="true"
        >
          +{checks.length - 5}
        </span>
      ) : null}
      {checks.length > 8 ? (
        <span
          data-run-check-overflow
          className="ml-1 hidden text-xs text-muted-foreground tabular-nums xl:inline"
          aria-hidden="true"
        >
          +{checks.length - 8}
        </span>
      ) : null}
      <span
        data-run-check-count
        className="ml-1 text-xs text-muted-foreground tabular-nums"
        aria-hidden="true"
      >
        {passedChecks}/{checks.length}
      </span>
    </div>
  );
}

function CompactCheckDots({
  probes,
  show,
}: {
  probes: readonly ScenarioProbeStatus[];
  show: boolean;
}) {
  if (!probes.length) return null;
  const passedChecks = countPassedChecks(probes);
  const visibleProbes = probes.slice(0, 4);
  const remainingChecks = probes.length - visibleProbes.length;
  return (
    <span
      className={cn("items-center gap-1", show ? "flex" : "hidden")}
      aria-hidden="true"
      data-run-compact-check-dots
    >
      {visibleProbes.map((probe, index) => {
        const status = learnerCheckStatus(probe.status);
        return (
          <span
            key={`${probe.id}:${index}`}
            className={cn(
              "size-2 rounded-full border",
              status === "verified"
                ? "border-success bg-success"
                : status === "checking"
                  ? "border-warning bg-transparent"
                  : "border-destructive bg-destructive",
            )}
          />
        );
      })}
      {remainingChecks ? (
        <span
          data-run-compact-check-overflow
          className="text-[0.6875rem] text-muted-foreground tabular-nums"
        >
          +{remainingChecks}
        </span>
      ) : null}
      <span
        data-run-compact-check-count
        className="ml-0.5 text-xs text-muted-foreground tabular-nums"
      >
        {passedChecks}/{probes.length}
      </span>
    </span>
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

function WorkOrder({ objectives }: { objectives: readonly ScenarioObjective[] }) {
  return (
    <section aria-labelledby="run-learning-work-order-heading">
      <div className="flex items-center justify-between gap-3">
        <p id="run-learning-work-order-heading" className="text-eyebrow">
          Work order
        </p>
        <Lightbulb className="size-4 text-primary" aria-hidden="true" />
      </div>
      {objectives.length ? (
        <ol className="mt-3 divide-y border-y">
          {objectives.map((objective, index) => (
            <li
              key={`${objective.probeName}:${index}`}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-3"
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
          Your work order will appear when the lab is ready.
        </p>
      )}
    </section>
  );
}

function Checks(props: {
  probes: readonly ScenarioProbeStatus[];
  objectives: readonly ScenarioObjective[];
  passedChecks: number;
}) {
  const checks = getLearnerChecks(props.probes, props.objectives);

  return (
    <section aria-labelledby="run-learning-checks-heading">
      <div className="flex items-center justify-between gap-3">
        <p id="run-learning-checks-heading" className="text-eyebrow">
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
        <ol className="mt-3 divide-y border-y">
          {checks.map((check) => {
            return (
              <li
                key={check.key}
                className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 py-3"
              >
                <span className="mt-0.5">
                  <CheckStatusIcon status={check.status} />
                </span>
                <span className="min-w-0 text-sm font-medium leading-6">
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
    <section aria-labelledby="run-learning-hints-heading">
      <div className="flex items-center justify-between gap-3">
        <p id="run-learning-hints-heading" className="text-eyebrow">
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
          No hints are available for this lab.
        </p>
      ) : (
        <div className="mt-3 space-y-5">
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
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
              <li key={hint.key} className="space-y-2 py-3">
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
              <li key={hint.key} className="py-3">
                <div className="flex min-h-11 items-center justify-between gap-3">
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
              className="flex min-h-11 items-center gap-2.5 py-3 text-muted-foreground"
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
      aria-labelledby="run-learning-solution-heading"
      className="border-t pt-5"
    >
      <p id="run-learning-solution-heading" className="text-eyebrow">
        Full solution
      </p>
      {props.solution.revealed ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            {props.solution.assisted
              ? "You used the full solution for this run."
              : "This solution unlocked after you completed the lab."}
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
            <DialogContent>
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

function panelHeading(state: LearningPanelState, showCheckList: boolean) {
  switch (state) {
    case "booting":
      return "Work order";
    case "solved":
      return "Lab solved";
    default:
      return showCheckList ? "Checks and guidance" : "Hints and guidance";
  }
}

function panelSummary(input: {
  state: LearningPanelState;
  passedChecks: number;
  totalChecks: number;
  showCheckList: boolean;
}) {
  if (input.state === "booting") {
    return "Read the work order now. Checks will appear when the lab is ready.";
  }
  if (input.state === "solved") {
    return "All available checks are verified. Finish when you are ready to save your work.";
  }
  if (!input.totalChecks) {
    return "Checks will appear when they are ready.";
  }
  if (!input.showCheckList) {
    return "Use a hint when you need a nudge. Your check circles stay visible above.";
  }
  return `${input.passedChecks} of ${input.totalChecks} checks are verified.`;
}

function useCompactLearningPanel() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}

function useExpandedCheckIndicators() {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(
      "(min-width: 1024px) and (hover: hover) and (pointer: fine)",
    );
    const update = () => setExpanded(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return expanded;
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
