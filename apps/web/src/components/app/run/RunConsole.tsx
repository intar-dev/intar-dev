import { useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { Badge } from "@/components/ui/badge";
import {
  formatProbeFailurePreview,
  formatProbeValueFields,
  summarizeProbeValue,
} from "@/lib/probe-values";
import { describeProbeValue } from "./run-support";
import type { ScenarioObjective, ScenarioProbeStatus } from "./run-types";

// The run console is one calm surface: borderless sections split by hairlines
// instead of stacked cards. The container owns the section rhythm.
export function RunConsole({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y [&>*]:py-4 [&>*:first-child]:pt-0">
      {children}
    </div>
  );
}

// The run's monitoring section: probes behave like live healthchecks — the
// system notices fixes on its own, there is no "check my solution" button.
export function ChecksSection(props: {
  vmName: string | null;
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  const passed = props.probes.filter((probe) => probe.status === "pass").length;
  const total = props.probes.length;
  const anyFailing = props.probes.some((probe) => probe.status === "fail");
  const resolved = total > 0 && passed === total;
  const focusProbeId =
    props.probes.find((probe) => probe.status !== "pass")?.id ?? null;
  // Untouched rows follow the live focus (first non-passing check) as checks
  // flip, so the open row advances with the incident. An explicit toggle
  // sticks only while its probe's status is unchanged — once the check flips,
  // focus-follow resumes.
  const [overrides, setOverrides] = useState<
    Record<string, { status: string; open: boolean }>
  >({});
  const isOpen = (probe: ScenarioProbeStatus) => {
    const override = overrides[probe.id];
    return override && override.status === probe.status
      ? override.open
      : probe.id === focusProbeId;
  };

  return (
    <section aria-label="Checks">
      <div className="flex items-center justify-between gap-3">
        <p className="text-eyebrow">
          {props.vmName ? `${props.vmName} checks` : "Checks"}
        </p>
        <span className="flex items-center gap-2">
          {total ? (
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {passed}/{total}
            </span>
          ) : null}
          {resolved ? (
            <Badge variant="success">Resolved</Badge>
          ) : anyFailing ? (
            <Badge variant="destructive">Failing checks</Badge>
          ) : (
            <Badge variant="outline">Investigating</Badge>
          )}
        </span>
      </div>
      {total ? (
        <div className="mt-1">
          {props.probes.map((probe) => (
            <CheckRow
              key={probe.id}
              probe={probe}
              objective={
                props.objectives.find(
                  (candidate) => candidate.probeName === probe.id,
                ) ?? null
              }
              open={isOpen(probe)}
              onOpenChange={(open) =>
                setOverrides((current) => ({
                  ...current,
                  [probe.id]: { status: probe.status, open },
                }))
              }
            />
          ))}
        </div>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">
          No checks in this section.
        </p>
      )}
    </section>
  );
}

function CheckRow(props: {
  probe: ScenarioProbeStatus;
  objective: ScenarioObjective | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { probe, objective } = props;
  const title = objective?.title?.trim() || probe.label;
  // Mono is reserved for actual probe values; the waiting/passing fallback
  // sentences are ordinary copy.
  const summary = summarizeProbeValue(probe.kind, probe.value);
  const valueFields =
    probe.status === "fail"
      ? formatProbeValueFields(probe.kind, probe.value)
      : [];
  const failurePreview =
    probe.status === "pass"
      ? null
      : formatProbeFailurePreview(probe.kind, probe.value, probe.error);

  return (
    <DisclosureRow
      density="compact"
      open={props.open}
      onOpenChange={props.onOpenChange}
      leading={<StatusIcon status={probe.status} />}
      title={title}
      contentClassName="space-y-1"
    >
      {objective?.bodyMarkdown ? (
        <Markdown className="space-y-1 text-xs leading-5 text-muted-foreground">
          {objective.bodyMarkdown}
        </Markdown>
      ) : null}
      {summary ? (
        <p className="font-mono text-xs break-all text-muted-foreground">
          {summary}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {describeProbeValue(probe)}
        </p>
      )}
      {valueFields.length ? (
        <dl className="grid gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/20 p-2 text-xs sm:grid-cols-[auto_1fr]">
          {valueFields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="contents">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="font-mono break-all text-foreground">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {failurePreview ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap">
          {failurePreview}
        </pre>
      ) : null}
    </DisclosureRow>
  );
}

// Status never by color alone: distinct icon shapes plus an sr-only word in
// the row's accessible name.
function StatusIcon({ status }: { status: string }) {
  if (status === "pass") {
    return (
      <>
        <CheckCircle2
          className="size-4 shrink-0 text-success"
          aria-hidden="true"
        />
        <span className="sr-only">Passing:</span>
      </>
    );
  }
  if (status === "fail") {
    return (
      <>
        <CircleAlert
          className="size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <span className="sr-only">Failing:</span>
      </>
    );
  }
  return (
    <>
      {/* Watching dot: the probe engine keeps checking on its own. */}
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <span className="size-2 rounded-full bg-warning" />
      </span>
      <span className="sr-only">Watching:</span>
    </>
  );
}
