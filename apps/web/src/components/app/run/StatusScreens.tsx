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
import { useJustReached } from "@/components/app/patterns/use-just-reached";

type StepState = ScenarioStatusStep["state"];

// Every state word sits in one end-aligned cell (a steady box), so the column
// is always as wide as "In progress" and a change swaps instead of resizing.
const STATE_WORDS: readonly StepState[] = [
  "pending",
  "active",
  "done",
  "failed",
];
const STATE_WORD_TONES: Record<StepState, string> = {
  pending: "text-faint-foreground",
  active: "text-brand-text",
  done: "text-faint-foreground",
  failed: "text-destructive",
};

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
  const stepStates = steps.map((step) => [step.id, step.state] as const);
  const justFinished = useJustReached(stepStates, "done");
  const justStarted = useJustReached(stepStates, "active");
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

  // The live region mounts empty and is filled after paint, so the first
  // message (including the hand-off from the start route) lands as a change
  // that assistive technology announces.
  const announcement =
    props.statusAnnouncement ??
    (currentStep
      ? `Stage ${currentStepIndex + 1} of ${props.steps.length}: ${currentStep.label}. ${currentStatus}.`
      : props.title);
  const [announced, setAnnounced] = useState("");
  useEffect(() => setAnnounced(announcement), [announcement]);

  // A closing fold keeps the text it last showed while it folds away.
  const lastDetail = useRef(new Map<string, string>());

  return (
    <Card
      ref={root}
      data-run-sequence-screen
      className="mx-auto w-full max-w-[36rem]"
    >
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
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
            <CardDescription>{props.description}</CardDescription>
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
          {announced}
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
                // The stretch glides over slow; fill and hairline fade over reveal.
                // Under reduced motion the stretch is instant; the fills still fade.
                "relative h-2 overflow-hidden rounded-full [transition:flex-grow_var(--duration-slow)_var(--ease-enter),flex-basis_var(--duration-slow)_var(--ease-enter),background-color_var(--duration-reveal)_var(--ease-standard),box-shadow_var(--duration-reveal)_var(--ease-standard)] motion-reduce:[transition:background-color_var(--duration-reveal)_var(--ease-standard),box-shadow_var(--duration-reveal)_var(--ease-standard)]",
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
                step.state === "pending" && "bg-border-strong/70",
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
            const open = isCurrent || step.state === "failed";
            if (open) lastDetail.current.set(step.id, step.detail);
            const detail = open
              ? step.detail
              : (lastDetail.current.get(step.id) ?? "");

            return (
              <li
                key={step.id}
                aria-current={isCurrent ? "step" : undefined}
                data-run-sequence-step
                data-state={step.state}
                className={cn(
                  "relative grid min-h-12 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg px-3 py-3 transition-colors duration-(--duration-slow) ease-standard",
                  step.state === "active" && "bg-primary/6",
                  step.state === "failed" && "bg-destructive/8",
                )}
              >
                {index < props.steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    data-run-sequence-connector
                    data-filled={step.state === "done" || undefined}
                    className="absolute top-[2.375rem] bottom-[-0.875rem] left-[calc(1.5rem-0.5px)] w-px bg-muted-foreground/40"
                  >
                    <span data-fill />
                  </span>
                ) : null}
                {/* The number, the drawn check and the alert share one cell, so
                    the marker swaps its content while its colours fade. */}
                <span
                  aria-hidden="true"
                  data-run-sequence-marker
                  className={cn(
                    "swap relative z-10 size-6 rounded-full border text-xs font-semibold tabular-nums transition-[background-color,border-color,color] duration-(--duration-moderate) ease-standard",
                    step.state === "done"
                      ? "border-success bg-success text-success-foreground"
                      : step.state === "active"
                        ? "border-primary bg-primary text-primary-foreground"
                        : step.state === "failed"
                          ? "border-destructive bg-destructive text-destructive-foreground"
                          : "border-muted-foreground bg-card text-muted-foreground",
                  )}
                >
                  <span
                    data-on={
                      step.state === "pending" ||
                      step.state === "active" ||
                      undefined
                    }
                  >
                    {index + 1}
                  </span>
                  <span data-on={step.state === "done" || undefined}>
                    <Check
                      className={cn(
                        "size-3.5",
                        justFinished.has(step.id) && "draw-check",
                      )}
                    />
                  </span>
                  <span data-on={step.state === "failed" || undefined}>
                    <CircleAlert className="size-3.5" />
                  </span>
                </span>
                {/* The copy box dissolves into the step grid so the detail can
                    run under the status column instead of wrapping early. The
                    short-landscape rail restores it as a block. */}
                <div className="contents" data-run-sequence-copy>
                  <p
                    className={cn(
                      "col-start-2 min-w-0 text-support leading-6 font-medium transition-colors duration-(--duration-slow) ease-standard",
                      step.state === "done"
                        ? "text-success"
                        : "text-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  {/* Only the working or failed stage shows its detail. The
                      fold opens over slow and closes keeping its last text. */}
                  <div
                    data-run-sequence-detail
                    data-open={open || undefined}
                    className="col-span-2 col-start-2 grid grid-rows-[0fr] transition-[grid-template-rows] duration-(--duration-slow) ease-enter data-open:grid-rows-[1fr] motion-reduce:transition-none"
                  >
                    <div
                      className={cn(
                        "min-h-0 overflow-hidden",
                        !open &&
                          "invisible [transition:visibility_0s_linear_var(--duration-slow)]",
                      )}
                    >
                      <p className="min-w-0 pt-0.5 text-metadata leading-5 text-muted-foreground">
                        {detail}
                      </p>
                    </div>
                  </div>
                </div>
                <span
                  data-run-sequence-status
                  className="swap col-start-3 row-start-1 justify-items-end text-label leading-6 whitespace-nowrap"
                >
                  {STATE_WORDS.map((word) => (
                    <span
                      key={word}
                      data-on={word === step.state || undefined}
                      className={STATE_WORD_TONES[word]}
                    >
                      {formatScenarioStepState(word)}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ol>
        {props.footer ? (
          <div data-run-sequence-foot className="animate-rise">
            {props.footer}
          </div>
        ) : null}
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
        <CardTitle as="h2" id="scenario-shell-title">
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
          <p className="text-support font-medium text-foreground">
            {props.phase === "failed"
              ? "Scenario run stopped"
              : "Shell unavailable"}
          </p>
          <p className="text-support text-muted-foreground">
            {props.phase === "failed"
              ? "This scenario stopped before the browser terminal opened. End the run and try again."
              : "The browser terminal will open when your workspace is ready."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
