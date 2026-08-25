import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover } from "@base-ui/react/popover";
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
  phase: RunLearningPanelProps["phase"];
  passedChecks: number;
  totalChecks: number;
  revealedHints: number;
  totalHints: number;
}): RunLearningTriggerCopy {
  const state = getRunLearningPanelState(input.phase);
  const checks = `${input.passedChecks} of ${input.totalChecks} checks verified`;
  const hints = input.totalHints
    ? `${input.revealedHints} of ${input.totalHints} hints revealed`
    : "no hints available";

  switch (state) {
    case "booting":
      return {
        visibleLabel: "Work order",
        accessibleLabel: `Work order. ${checks}. ${hints}.`,
      };
    case "solved":
      return {
        visibleLabel: `Solved ${input.passedChecks}/${input.totalChecks}`,
        accessibleLabel: `Solved. ${checks}. ${hints}.`,
      };
    default:
      return {
        visibleLabel: `Checks ${input.passedChecks}/${input.totalChecks}`,
        accessibleLabel: `Checks. ${checks}. ${hints}.`,
      };
  }
}

/**
 * Shared learner panel for the app bar. Desktop and tablet use an anchored,
 * non-modal popover; narrow screens use a bottom sheet. The content stays in
 * one component so polling cannot make the two experiences drift apart.
 */
export function RunLearningPanel(props: RunLearningPanelProps) {
  const compact = useCompactLearningPanel();
  const passedChecks = countPassedChecks(props.probes);
  const hints = useMemo(
    () => scopeHintsToVm(props.hints, props.vmName),
    [props.hints, props.vmName],
  );
  const revealedHints = countRevealedHints(hints);
  const copy = getRunLearningTriggerCopy({
    phase: props.phase,
    passedChecks,
    totalChecks: props.probes.length,
    revealedHints,
    totalHints: hints.length,
  });
  const announcement = useCheckAnnouncement({
    passedChecks,
    totalChecks: props.probes.length,
  });

  const trigger = renderRunLearningPanelTrigger({
    visibleLabel: copy.visibleLabel,
    accessibleLabel: copy.accessibleLabel,
  });
  const content = <RunLearningPanelContent {...props} hints={hints} />;

  return (
    <>
      {compact ? (
        <Sheet>
          <SheetTrigger render={trigger} />
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="max-h-[min(78dvh,42rem)] rounded-t-2xl border-x border-t pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Lab guidance</SheetTitle>
              <SheetDescription>
                Your checks, hints, and solution.
              </SheetDescription>
            </SheetHeader>
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
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
              {content}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover.Root modal={false}>
          <Popover.Trigger render={trigger} />
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={8}>
              <Popover.Popup
                className="z-50 w-[min(26rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none motion-safe:duration-150 data-ending-style:opacity-0 data-ending-style:translate-y-1 data-starting-style:opacity-0 data-starting-style:translate-y-1"
                aria-label="Lab guidance"
              >
                <Popover.Title className="sr-only">Lab guidance</Popover.Title>
                <Popover.Description className="sr-only">
                  Your checks, hints, and solution.
                </Popover.Description>
                <Popover.Close
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
                </Popover.Close>
                <div className="max-h-[min(42rem,calc(100dvh-var(--app-bar-h,3rem)-1rem))] overflow-y-auto overscroll-contain px-4 pb-4">
                  {content}
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
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
  const passedChecks = countPassedChecks(props.probes);
  const hints = useMemo(
    () => scopeHintsToVm(props.hints, props.vmName),
    [props.hints, props.vmName],
  );
  const revealedHints = countRevealedHints(hints);
  const objectives = useMemo(() => {
    if (!props.vmName) return props.objectives;
    const scoped = props.objectives.filter(
      (objective) => objective.vmName === props.vmName,
    );
    return scoped.length ? scoped : props.objectives;
  }, [props.objectives, props.vmName]);

  return (
    <div
      data-run-learning-panel-content
      className={cn("space-y-6 pb-2", props.className)}
    >
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

      <header className="pr-12">
        <p className="text-eyebrow">Lab guidance</p>
        <h2 id={headingId} className="mt-1 font-heading text-lg font-semibold">
          {panelHeading(state)}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {panelSummary({ state, passedChecks, totalChecks: props.probes.length })}
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

function renderRunLearningPanelTrigger(props: RunLearningTriggerCopy) {
  return (
    <Button
      type="button"
      variant="outline"
      size="default"
      className="max-w-44 px-3 sm:max-w-none"
      aria-label={props.accessibleLabel}
      data-run-learning-panel-trigger
    >
      <ListChecks className="size-4" aria-hidden="true" />
      <span className="truncate">{props.visibleLabel}</span>
    </Button>
  );
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
  return (
    <section aria-labelledby="run-learning-checks-heading">
      <div className="flex items-center justify-between gap-3">
        <p id="run-learning-checks-heading" className="text-eyebrow">
          Checks
        </p>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          aria-label={`${props.passedChecks} of ${props.probes.length} checks verified`}
        >
          {props.passedChecks}/{props.probes.length} verified
        </span>
      </div>
      {props.probes.length ? (
        <ol className="mt-3 divide-y border-y">
          {props.probes.map((probe, index) => {
            const objectiveIndex = props.objectives.findIndex(
              (candidate) => candidate.probeName === probe.id,
            );
            const objective =
              objectiveIndex >= 0
                ? (props.objectives[objectiveIndex] ?? null)
                : null;
            const status = learnerCheckStatus(probe.status);

            return (
              <li
                key={`${probe.id}:${index}`}
                className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 py-3"
              >
                {status === "verified" ? (
                  <CheckCircle2
                    className="mt-0.5 size-4 text-success"
                    aria-hidden="true"
                  />
                ) : status === "checking" ? (
                  <LoaderCircle
                    className="mt-0.5 size-4 text-warning motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleAlert
                    className="mt-0.5 size-4 text-destructive"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 text-sm font-medium leading-6">
                  {repairObjectiveTitle(
                    objective,
                    objectiveIndex >= 0 ? objectiveIndex : index,
                  )}
                </span>
                <span
                  className={cn(
                    "pt-0.5 text-xs font-medium whitespace-nowrap",
                    status === "verified"
                      ? "text-success"
                      : status === "checking"
                        ? "text-warning"
                        : "text-destructive",
                  )}
                >
                  {status === "verified"
                    ? "Verified"
                    : status === "checking"
                      ? "Checking"
                      : "Needs repair"}
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

function learnerCheckStatus(status: string) {
  if (isVerificationPassed(status)) return "verified" as const;
  return ["", "pending", "unknown", "queued", "checking"].includes(
    status.trim().toLowerCase(),
  )
    ? ("checking" as const)
    : ("needs_repair" as const);
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

function panelHeading(state: LearningPanelState) {
  switch (state) {
    case "booting":
      return "Work order";
    case "solved":
      return "Lab solved";
    default:
      return "Checks and guidance";
  }
}

function panelSummary(input: {
  state: LearningPanelState;
  passedChecks: number;
  totalChecks: number;
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
