import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { Badge } from "@/components/ui/badge";
import { repairObjectiveTitle } from "@/lib/verification-copy";
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

// Learners work from repair objectives, not probe implementation details. The
// verification engine stays automatic and invisible behind this progress list.
export function RepairProgressSection(props: {
  vmName: string | null;
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  const passed = props.probes.filter((probe) => probe.status === "pass").length;
  const total = props.probes.length;
  const anyNeedsRepair = props.probes.some(
    (probe) => probe.status === "fail" && !probe.error?.trim(),
  );
  const anyRetrying = props.probes.some(
    (probe) => probe.status === "error" || Boolean(probe.error?.trim()),
  );
  const resolved = total > 0 && passed === total;

  return (
    <section aria-label="Repair progress">
      <div className="flex items-center justify-between gap-3">
        <p className="text-eyebrow">
          {props.vmName ? `${props.vmName} repair progress` : "Repair progress"}
        </p>
        <span className="flex items-center gap-2">
          {total ? (
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {passed} of {total} verified
            </span>
          ) : null}
          {resolved ? (
            <Badge variant="success">All verified</Badge>
          ) : anyNeedsRepair ? (
            <Badge variant="destructive">Repair in progress</Badge>
          ) : anyRetrying ? (
            <Badge variant="warning">Verification retrying</Badge>
          ) : (
            <Badge variant="outline">Checking objectives</Badge>
          )}
        </span>
      </div>
      {total ? (
        <ol className="mt-2 divide-y border-y">
          {props.probes.map((probe, index) => {
            const objectiveIndex = props.objectives.findIndex(
              (candidate) => candidate.probeName === probe.id,
            );
            return (
              <CheckRow
                key={probe.id}
                probe={probe}
                objective={
                  objectiveIndex >= 0
                    ? (props.objectives[objectiveIndex] ?? null)
                    : null
                }
                objectiveIndex={objectiveIndex >= 0 ? objectiveIndex : index}
              />
            );
          })}
        </ol>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">
          No repair objectives are available yet.
        </p>
      )}
    </section>
  );
}

function CheckRow(props: {
  probe: ScenarioProbeStatus;
  objective: ScenarioObjective | null;
  objectiveIndex: number;
}) {
  const { probe, objective } = props;
  const title = repairObjectiveTitle(objective, props.objectiveIndex);
  const presentation = objectivePresentation(probe);

  return (
    <li className="flex gap-3 py-3">
      <StatusIcon
        status={probe.status}
        retrying={probe.status === "error" || Boolean(probe.error?.trim())}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <Badge variant={presentation.variant} className="shrink-0">
            {presentation.label}
          </Badge>
        </div>
        {objective?.bodyMarkdown ? (
          <Markdown className="max-w-[68ch] space-y-1 text-sm leading-5 text-muted-foreground">
            {objective.bodyMarkdown}
          </Markdown>
        ) : null}
        {presentation.detail ? (
          <p className="max-w-[68ch] text-xs leading-5 text-muted-foreground">
            {presentation.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function objectivePresentation(probe: ScenarioProbeStatus) {
  if (probe.status === "pass") {
    return { label: "Verified", variant: "success" as const, detail: null };
  }
  if (probe.status === "error" || probe.error?.trim()) {
    return {
      label: "Retrying",
      variant: "warning" as const,
      detail:
        "Verification is temporarily unavailable. The workspace will try again automatically.",
    };
  }
  if (probe.status === "fail") {
    return {
      label: "Needs repair",
      variant: "destructive" as const,
      detail: null,
    };
  }
  return {
    label: "Checking",
    variant: "outline" as const,
    detail: "The workspace is checking this repair objective.",
  };
}

// Status never relies on color alone: each shape is paired with a visible
// status badge in the same row.
function StatusIcon({ status, retrying }: { status: string; retrying: boolean }) {
  if (status === "pass") {
    return (
      <CheckCircle2
        className="mt-0.5 size-4 shrink-0 text-success"
        aria-hidden="true"
      />
    );
  }
  if (retrying) {
    return (
      <CircleAlert
        className="mt-0.5 size-4 shrink-0 text-warning"
        aria-hidden="true"
      />
    );
  }
  if (status === "fail") {
    return (
      <CircleAlert
        className="mt-0.5 size-4 shrink-0 text-destructive"
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      <span className="size-2 rounded-full bg-warning" />
    </span>
  );
}
