import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
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
  topRight?: ReactNode;
  statusAnnouncement?: string;
}) {
  const currentStep = props.steps.find(
    (step) => step.state === "active" || step.state === "failed",
  );
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle
              as="h2"
              className="font-heading text-lg font-semibold tracking-tight"
            >
              {props.title}
            </CardTitle>
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
        >
          {props.statusAnnouncement ??
            (currentStep
              ? `${props.title}: ${currentStep.label}`
              : props.title)}
        </p>
        <ol className="space-y-3">
          {props.steps.map((step) => (
            <li
              key={step.id}
              aria-current={currentStep?.id === step.id ? "step" : undefined}
              className={cn(
                "flex items-start gap-3 rounded-lg px-4 py-3 text-sm",
                step.state === "done"
                  ? "bg-success/8"
                  : step.state === "active"
                    ? "bg-primary/6"
                    : step.state === "failed"
                      ? "bg-destructive/8"
                      : "bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  step.state === "done"
                    ? "bg-success"
                    : step.state === "active"
                      ? "bg-primary"
                      : step.state === "failed"
                        ? "bg-destructive"
                        : "bg-border",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p
                    className={cn(
                      "font-medium",
                      step.state === "done"
                        ? "text-success"
                        : "text-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      step.state === "done"
                        ? "bg-success/15 text-success"
                        : step.state === "active"
                          ? "bg-primary/10 text-primary"
                          : step.state === "failed"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground",
                    )}
                  >
                    {formatScenarioStepState(step.state)}
                  </span>
                </div>
                <p
                  className={cn(
                    "leading-6",
                    step.state === "done"
                      ? "text-success"
                      : "text-muted-foreground",
                  )}
                >
                  {step.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function ScenarioShellStatusCard(props: {
  phase: ScenarioRunRecord["phase"];
  title: string;
  description: string;
  pending?: boolean;
}) {
  const isTransient =
    props.pending === true ||
    props.phase === "deleting" ||
    props.phase === "archiving";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Shell</CardTitle>
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
            {props.description}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
