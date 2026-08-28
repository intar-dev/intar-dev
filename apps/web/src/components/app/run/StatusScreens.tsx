import type { ReactNode, Ref } from "react";
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
}) {
  const currentStep = props.steps.find(
    (step) => step.state === "active" || step.state === "failed",
  );
  const nextStepIndex = props.steps.findIndex(
    (step) => step.state === "pending",
  );
  const currentStepIndex = currentStep
    ? props.steps.findIndex((step) => step.id === currentStep.id)
    : nextStepIndex >= 0
      ? nextStepIndex
      : Math.max(0, props.steps.length - 1);
  const currentStatus = currentStep
    ? formatScenarioStepState(currentStep.state)
    : null;

  return (
    <Card data-run-sequence-screen>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            {props.steps.length ? (
              <p className="text-label" data-run-sequence-position>
                Stage {currentStepIndex + 1} of {props.steps.length}
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
      <CardContent className="space-y-6">
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
        <ol
          aria-label={props.listLabel}
          className="space-y-1"
          data-run-sequence-steps
        >
          {props.steps.map((step, index) => {
            const isCurrent = currentStep?.id === step.id;
            const statusLabel = formatScenarioStepState(step.state);

            return (
              <li
                key={step.id}
                aria-current={isCurrent ? "step" : undefined}
                data-run-sequence-step
                data-state={step.state}
                className={cn(
                  "relative grid min-h-12 grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg px-3 py-3 text-sm",
                  step.state === "active" && "bg-primary/6",
                  step.state === "failed" && "bg-destructive/8",
                )}
              >
                {index < props.steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    data-run-sequence-connector
                    className={cn(
                      "absolute top-9 bottom-[-1rem] left-6 w-px",
                      step.state === "done"
                        ? "bg-success/60"
                        : "bg-muted-foreground/40",
                    )}
                  />
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
                    <Check className="size-3.5" />
                  ) : step.state === "failed" ? (
                    <CircleAlert className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
                <div
                  className="min-w-0 space-y-1"
                  data-run-sequence-copy
                >
                  <p
                    className={cn(
                      "font-medium leading-6",
                      step.state === "done"
                        ? "text-success"
                        : "text-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  {isCurrent || step.state === "failed" ? (
                    <p
                      className="leading-6 text-muted-foreground"
                      data-run-sequence-detail
                    >
                      {step.detail}
                    </p>
                  ) : null}
                </div>
                <span
                  data-run-sequence-status
                  className={cn(
                    "pt-0.5 text-xs font-medium whitespace-nowrap",
                    step.state === "done"
                      ? "text-success"
                      : step.state === "active"
                        ? "text-primary"
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
      <CardHeader className="pb-3">
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
        <div className="max-w-md space-y-2">
          <p className="text-sm font-medium text-foreground">
            {props.phase === "failed"
              ? "Scenario run stopped"
              : "Shell unavailable"}
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            {props.phase === "failed"
              ? "This lab stopped before the browser terminal opened. End the run and try again."
              : "The browser terminal will open when your workspace is ready."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
