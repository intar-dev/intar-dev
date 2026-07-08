import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, CircleAlert, Clock3 } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { parseProbeValue } from "@/lib/probe-values";
import { cn } from "@/lib/utils";
import { LeaseCountdown } from "./LeaseCountdown";
import { ProbeDetail } from "./ProbeDetail";
import { describeProbeValue, formatScenarioElapsedTime } from "./run-support";
import type { ScenarioObjective, ScenarioProbeStatus } from "./run-types";

// The run's monitoring pane: probes behave like live healthchecks — the
// system notices fixes on its own, there is no "check my solution" button.
export function OpsConsoleRail(props: {
  vmName: string | null;
  createdAt: number;
  solveDurationMs: number | null;
  leaseDeadlineMs: number | null;
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  const passed = props.probes.filter((probe) => probe.status === "pass").length;
  const total = props.probes.length;
  const anyFailing = props.probes.some((probe) => probe.status === "fail");
  const resolved = total > 0 && passed === total;
  const focusProbeId =
    props.probes.find((probe) => probe.status !== "pass")?.id ?? null;

  return (
    <Card size="sm">
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="font-heading text-base">Incident</CardTitle>
          {resolved ? (
            <Badge variant="success">Resolved</Badge>
          ) : anyFailing ? (
            <Badge variant="destructive">Failing checks</Badge>
          ) : (
            <Badge variant="outline">Investigating</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <ElapsedTimer
            createdAt={props.createdAt}
            solveDurationMs={props.solveDurationMs}
          />
          <LeaseCountdown deadlineMs={props.leaseDeadlineMs} className="text-xs" />
        </div>
        {total ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-eyebrow">
                {props.vmName ? `${props.vmName} checks` : "Checks"}
              </span>
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                {passed}/{total}
              </span>
            </div>
            {/* One segment per probe — segments cannot lie the way percents do. */}
            <div className="flex gap-1">
              {props.probes.map((probe) => (
                <span
                  key={probe.id}
                  className={cn(
                    "h-1.5 flex-1 rounded-full",
                    probe.status === "pass"
                      ? "bg-success"
                      : probe.status === "fail"
                        ? "bg-destructive/70"
                        : "bg-muted",
                    probe.id === focusProbeId &&
                      probe.status !== "fail" &&
                      "motion-safe:animate-pulse",
                  )}
                />
              ))}
            </div>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {props.probes.length ? (
          props.probes.map((probe) => (
            <ProbeHealthRow
              key={probe.id}
              probe={probe}
              objective={
                props.objectives.find(
                  (candidate) => candidate.probeName === probe.id,
                ) ?? null
              }
              focused={probe.id === focusProbeId}
            />
          ))
        ) : (
          <p className="px-1 py-4 text-sm text-muted-foreground">
            No checks in this section.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Self-ticking elapsed clock; freezes at the solve duration once solved.
function ElapsedTimer(props: {
  createdAt: number;
  solveDurationMs: number | null;
}) {
  const frozen = props.solveDurationMs !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [frozen]);

  const elapsedSeconds = frozen
    ? Math.max(0, Math.floor((props.solveDurationMs ?? 0) / 1000))
    : Math.max(0, Math.floor((now - props.createdAt) / 1000));

  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono tabular-nums"
      title={frozen ? "Time to resolve" : "Time elapsed in this run"}
    >
      <Clock3 className="size-3.5" />
      {formatScenarioElapsedTime(elapsedSeconds)}
    </span>
  );
}

function ProbeHealthRow(props: {
  probe: ScenarioProbeStatus;
  objective: ScenarioObjective | null;
  focused: boolean;
}) {
  const { probe, objective, focused } = props;
  const title = objective?.title?.trim() || probe.label;

  if (probe.status === "pass") {
    return (
      <div className="rounded-lg bg-success/8 px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <CheckCircle2
            className="size-4 shrink-0 text-success"
            aria-hidden="true"
          />
          <p className="min-w-0 truncate text-sm font-medium text-success">
            {title}
          </p>
        </div>
        {probe.error ? (
          <p className="mt-1.5 pl-6.5 text-xs text-destructive">
            {probe.error}
          </p>
        ) : null}
      </div>
    );
  }

  const failed = probe.status === "fail";
  const row = (
    <div
      className={cn(
        "rounded-lg px-3 py-3",
        focused ? "rounded-[7px] bg-card" : "border",
        failed && !focused && "border-destructive/30 bg-destructive/5",
      )}
    >
      {focused ? (
        <p className="text-eyebrow mb-1.5 text-gradient-brand">Current focus</p>
      ) : null}
      <div className="flex items-start gap-2.5">
        {failed ? (
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : (
          <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
            {/* Watching dot: the probe engine keeps checking on its own. */}
            <span
              className="size-2 rounded-full bg-warning motion-safe:animate-pulse"
              aria-hidden="true"
            />
            <span className="sr-only">watching</span>
          </span>
        )}
        <p className="min-w-0 flex-1 text-sm font-medium">{title}</p>
      </div>
      {focused && objective?.bodyMarkdown ? (
        <Markdown className="mt-2.5 space-y-2 pl-6.5 text-xs leading-6 text-muted-foreground">
          {objective.bodyMarkdown}
        </Markdown>
      ) : null}
      {probe.error ? (
        <p className="mt-2 pl-6.5 text-xs text-destructive">{probe.error}</p>
      ) : failed && parseProbeValue(probe.kind, probe.value) ? (
        <ProbeDetail
          kind={probe.kind}
          value={probe.value}
          className="mt-3 ml-6.5 rounded-md border border-destructive/20 bg-background/60 p-2.5"
        />
      ) : null}
      <WhatThisChecks
        probe={probe}
        objective={focused ? null : objective}
      />
    </div>
  );

  if (!focused) {
    return row;
  }

  // Brand-gradient focus ring on the first incomplete objective.
  return (
    <div
      className="rounded-lg p-px"
      style={{ backgroundImage: "var(--gradient-brand)" }}
    >
      {row}
    </div>
  );
}

// A plain-language description of what the probe verifies — trust that
// green means green, and a legitimate tier-zero hint in one.
function WhatThisChecks(props: {
  probe: ScenarioProbeStatus;
  objective: ScenarioObjective | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 pl-6.5">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
        What this checks
      </button>
      {open ? (
        <div className="mt-1.5 space-y-2">
          {props.objective?.bodyMarkdown ? (
            <Markdown className="space-y-2 text-xs leading-6 text-muted-foreground">
              {props.objective.bodyMarkdown}
            </Markdown>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {describeProbeValue(props.probe)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
