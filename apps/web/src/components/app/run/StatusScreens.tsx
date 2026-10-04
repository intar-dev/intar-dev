import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatScenarioStepState } from "./run-support";
import type { ScenarioRunRecord, ScenarioStatusStep } from "./run-types";
import { RollingNumber } from "@/components/app/patterns/RollingNumber";

type StepState = ScenarioStatusStep["state"];

/**
 * Steps that reached `state` while this screen was open. A stage that was
 * already there when the screen mounted stays still (the Moment Rule): no
 * check draws itself and no sweep plays on load or revisit.
 */
function useJustBecame(steps: ScenarioStatusStep[], state: StepState) {
  const previous = useRef<Map<string, StepState> | null>(null);
  const [reached, setReached] = useState<ReadonlySet<string>>(new Set());
  const signature = steps.map((step) => `${step.id}:${step.state}`).join("|");
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = new Map(steps.map((step) => [step.id, step.state]));
    if (!before) return;
    const now = steps
      .filter(
        (step) =>
          step.state === state &&
          before.has(step.id) &&
          before.get(step.id) !== state,
      )
      .map((step) => step.id);
    if (now.length) setReached((current) => new Set([...current, ...now]));
    // `signature` captures every state change; `steps` is a new array each render.
  }, [signature]);
  return reached;
}

/**
 * One startup sequence spans two screens: the start route, then the run
 * page. The first leaves its stage states under a key and the second takes
 * them, so the track carries on from where it was instead of loading again.
 */
const handoffs = new Map<
  string,
  { states: ReadonlyMap<string, StepState>; at: number }
>();
const HANDOFF_TTL_MS = 15_000;

function takeHandoff(key: string | undefined) {
  if (!key) return null;
  const handoff = handoffs.get(key);
  handoffs.delete(key);
  return handoff && Date.now() - handoff.at < HANDOFF_TTL_MS
    ? handoff.states
    : null;
}

export function ScenarioStepScreen(props: {
  title: string;
  description: string;
  steps: ScenarioStatusStep[];
  headingId?: string;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  listLabel?: string;
  topRight?: ReactNode;
  statusAnnouncement?: string;
  footer?: ReactNode;
  /** Leave this sequence's states for the next screen under this key. */
  handoffTo?: string;
  /** Carry on from the states another screen left under this key. */
  handoffFrom?: string;
}) {
  // A handed-off sequence paints its previous states once, then advances, so
  // the stages that moved on in between animate like any other hand-off.
  const [handoff] = useState(() => takeHandoff(props.handoffFrom));
  const [advanced, setAdvanced] = useState(!handoff);
  const root = useRef<HTMLDivElement>(null);
  const steps =
    advanced || !handoff
      ? props.steps
      : props.steps.map((step) => ({
          ...step,
          state: handoff.get(step.id) ?? step.state,
        }));
  const justFinished = useJustBecame(steps, "done");
  const justStarted = useJustBecame(steps, "active");
  useLayoutEffect(() => {
    if (advanced) return;
    // Style the handed-off states before advancing, so the change transitions.
    void root.current?.offsetWidth;
    setAdvanced(true);
  }, [advanced]);
  useEffect(() => {
    if (!props.handoffTo) return;
    handoffs.set(props.handoffTo, {
      states: new Map(props.steps.map((step) => [step.id, step.state])),
      at: Date.now(),
    });
  });

  const currentStep = steps.find(
    (step) => step.state === "active" || step.state === "failed",
  );
  const nextStepIndex = steps.findIndex((step) => step.state === "pending");
  const currentStepIndex = currentStep
    ? steps.findIndex((step) => step.id === currentStep.id)
    : nextStepIndex >= 0
      ? nextStepIndex
      : Math.max(0, steps.length - 1);
  const currentStatus = currentStep
    ? formatScenarioStepState(currentStep.state)
    : null;

  return (
    <Card ref={root} data-run-sequence-screen>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            {props.steps.length ? (
              <p className="text-label" data-run-sequence-position>
                Stage <RollingNumber value={currentStepIndex + 1} /> of{" "}
                {props.steps.length}
              </p>
            ) : null}
            <h2
              id={props.headingId}
              ref={props.headingRef}
              tabIndex={props.headingRef ? -1 : undefined}
              className="text-section-title outline-none"
            >
              {props.title}
            </h2>
            <CardDescription className="leading-6">
              {props.description}
            </CardDescription>
          </div>
          {props.topRight ? (
            <div className="shrink-0 self-start">{props.topRight}</div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-run-sequence-announcement
        >
          {props.statusAnnouncement ??
            (currentStep
              ? `Stage ${currentStepIndex + 1} of ${props.steps.length}: ${currentStep.label}. ${currentStatus}.`
              : props.title)}
        </p>
        {/* The stage track: finished stages settle into dots, and the working
            stage stretches into a bar that one sweep crosses as it starts. */}
        <div
          aria-hidden="true"
          className="flex items-center gap-1.5"
          data-run-sequence-track
        >
          {steps.map((step) => (
            <span
              key={step.id}
              className={cn(
                "relative h-2 overflow-hidden rounded-full transition-[flex-grow,flex-basis,background-color,box-shadow] duration-300 ease-enter motion-reduce:transition-none",
                step.state === "active" || step.state === "failed"
                  ? "grow basis-0"
                  : "grow-0 basis-2",
                step.state === "done" && "bg-success",
                step.state === "active" &&
                  "bg-brand-subtle shadow-[inset_0_0_0_1px_var(--brand-border)]",
                step.state === "active" &&
                  justStarted.has(step.id) &&
                  "stage-sweep",
                step.state === "failed" && "bg-destructive",
                step.state === "pending" && "bg-border-strong/35",
              )}
            />
          ))}
        </div>
        <ol
          aria-label={props.listLabel}
          className="space-y-1"
          data-run-sequence-steps
        >
          {steps.map((step, index) => {
            const isCurrent = currentStep?.id === step.id;
            const statusLabel = formatScenarioStepState(step.state);

            return (
              <li
                key={step.id}
                aria-current={isCurrent ? "step" : undefined}
                data-run-sequence-step
                data-state={step.state}
                className={cn(
                  "relative grid min-h-12 grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg px-3 py-3 text-sm transition-colors duration-300 motion-reduce:transition-none",
                  step.state === "active" && "bg-primary/6",
                  step.state === "failed" && "bg-destructive/8",
                )}
              >
                {index < props.steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    data-run-sequence-connector
                    data-filled={step.state === "done" || undefined}
                    className="absolute top-9 bottom-[-1rem] left-6 w-px bg-muted-foreground/40"
                  >
                    <span data-fill />
                  </span>
                ) : null}
                <span
                  aria-hidden="true"
                  data-run-sequence-marker
                  className={cn(
                    "relative z-10 flex size-6 items-center justify-center rounded-full border text-xs font-semibold tabular-nums motion-reduce:transition-none",
                    step.state === "done"
                      ? "border-success bg-success text-success-foreground"
                      : step.state === "active"
                        ? "border-primary bg-primary text-primary-foreground"
                        : step.state === "failed"
                          ? "border-destructive bg-destructive text-destructive-foreground"
                          : "border-muted-foreground bg-card text-muted-foreground",
                  )}
                >
                  {step.state === "done" ? (
                    <Check
                      className={cn(
                        "size-3.5",
                        justFinished.has(step.id) && "draw-check",
                      )}
                    />
                  ) : step.state === "failed" ? (
                    <CircleAlert className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
                {/* The copy box dissolves into the step grid so the detail can
                    run under the status column instead of wrapping early. The
                    short-landscape rail restores it as a block. */}
                <div
                  className="contents space-y-1"
                  data-run-sequence-copy
                >
                  <p
                    className={cn(
                      "col-start-2 min-w-0 font-medium leading-6",
                      step.state === "done"
                        ? "text-success"
                        : "text-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  {isCurrent || step.state === "failed" ? (
                    <p
                      className="col-span-2 col-start-2 min-w-0 leading-6 text-muted-foreground"
                      data-run-sequence-detail
                    >
                      {step.detail}
                    </p>
                  ) : null}
                </div>
                <span
                  data-run-sequence-status
                  className={cn(
                    "col-start-3 row-start-1 text-xs leading-6 font-medium whitespace-nowrap",
                    step.state === "done"
                      ? "text-success"
                      : step.state === "active"
                        ? "text-brand-text"
                        : step.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                  )}
                >
                  {statusLabel}
                </span>
              </li>
            );
          })}
        </ol>
        {props.footer}
      </CardContent>
    </Card>
  );
}

export function ScenarioShellStatusCard(props: {
  phase: ScenarioRunRecord["phase"];
  title: string;
  pending?: boolean;
}) {
  const isTransient =
    props.pending === true ||
    props.phase === "deleting" ||
    props.phase === "archiving";

  return (
    <Card as="section" aria-labelledby="scenario-shell-title">
      <CardHeader>
        <CardTitle as="h2" id="scenario-shell-title" className="text-base">
          Shell
        </CardTitle>
        <CardDescription>{props.title}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-[20rem] flex-col items-center justify-center gap-4 text-center">
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {props.title}
        </p>
        {isTransient ? (
          <LoaderCircle className="size-8 text-primary motion-safe:animate-spin" />
        ) : null}
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {props.phase === "failed"
              ? "Scenario run stopped"
              : "Shell unavailable"}
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            {props.phase === "failed"
              ? "This scenario stopped before the browser terminal opened. End the run and try again."
              : "The browser terminal will open when your workspace is ready."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
