import type { ReactNode } from "react";
import { CheckCircle2, Clock3, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  describeProbeValue,
  formatScenarioDurationMs,
  formatScenarioStepState,
} from "./run-support";
import type {
  ScenarioProbeStatus,
  ScenarioRunRecord,
  ScenarioStatusStep,
} from "./run-types";

export function ScenarioStepScreen(props: {
  title: string;
  description: string;
  progressLabel?: string;
  progressPercent?: number;
  steps: ScenarioStatusStep[];
  topRight?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="font-heading text-xl font-semibold tracking-tight">
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
      <CardContent className="space-y-6" aria-live="polite">
        {typeof props.progressPercent === "number" ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                {props.progressLabel ?? "In progress"}
              </span>
              <span className="font-medium text-foreground">
                {props.progressPercent}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary motion-safe:transition-[width] duration-300"
                style={{ width: `${props.progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        <ul className="space-y-3">
          {props.steps.map((step) => (
            <li
              key={step.id}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3 py-2 text-sm",
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
                      ? "text-success/80"
                      : "text-muted-foreground",
                  )}
                >
                  {step.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function ScenarioSuccessOverlay(props: {
  scenarioName: string;
  probes: ScenarioProbeStatus[];
  solveDurationMs: number | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  const solvedProbes = props.probes.filter((probe) => probe.status === "pass");

  return (
    <div className="fixed inset-0 z-40 bg-background p-4 sm:p-8">
      <div className="mx-auto flex h-full w-full max-w-7xl items-center justify-center">
        <div className="w-full space-y-6 rounded-xl border border-success/30 bg-success/[0.05] p-6 shadow-sm sm:p-8">
          <div className="space-y-4">
            <Badge
              variant="outline"
              className="w-fit border-success/30 bg-success/10 text-success"
            >
              <CheckCircle2 className="size-3.5" />
              Success
            </Badge>
            <div className="space-y-2">
              <h2 className="font-heading text-3xl font-bold tracking-tight text-foreground">
                Nice work.
              </h2>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
                You solved {props.scenarioName}. End the scenario to save your
                replay and wrap up this run.
              </p>
            </div>
            {props.solveDurationMs !== null ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-success/20 bg-background/80 px-3 py-1 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" />
                <span>Solved in {formatScenarioDurationMs(props.solveDurationMs)}</span>
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">Solved checks</p>
            {solvedProbes.length ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {solvedProbes.map((probe) => (
                  <li
                    key={probe.id}
                    className="flex items-start gap-3 rounded-lg border border-success/20 bg-background/80 px-3 py-3"
                  >
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {probe.label}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {probe.error ?? describeProbeValue(probe)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-success/20 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                All scenario checks are complete.
              </div>
            )}
          </div>

          <Button
            size="lg"
            className="h-12 w-full bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <CheckCircle2 className="size-4" />
            {props.pending ? "Ending scenario..." : "End scenario"}
          </Button>
        </div>
      </div>
    </div>
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
      <CardContent
        className="flex min-h-[20rem] flex-col items-center justify-center gap-4 text-center"
        aria-live="polite"
      >
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
