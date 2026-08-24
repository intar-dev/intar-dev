import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { Badge } from "@/components/ui/badge";
import {
  isVerificationPassed,
  repairObjectiveTitle,
  verificationStatusLabel,
} from "@/lib/verification-copy";
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
  const passed = props.probes.filter((probe) =>
    isVerificationPassed(probe.status),
  ).length;
  const total = props.probes.length;
  const needsRepair = total - passed;
  const verificationUnavailable = props.probes.some(
    (probe) =>
      !isVerificationPassed(probe.status) &&
      (probe.status.trim().toLowerCase() === "error" ||
        Boolean(probe.error?.trim())),
  );

  return (
    <section aria-label="Repair progress">
      <div className="flex items-center justify-between gap-3">
        <p className="text-eyebrow">
          {props.vmName ? `${props.vmName} repair progress` : "Repair progress"}
        </p>
        {total ? (
          <span
            className="flex flex-wrap items-center justify-end gap-2 tabular-nums"
            aria-label={`${passed} verified, ${needsRepair} need repair`}
          >
            <Badge variant="success">{passed} Verified</Badge>
            <Badge variant="destructive">
              {needsRepair} Needs repair
            </Badge>
          </span>
        ) : null}
      </div>
      {verificationUnavailable ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Verification unavailable. We cannot confirm all progress right now.
        </p>
      ) : null}
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
      <StatusIcon status={probe.status} />
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
      </div>
    </li>
  );
}

function objectivePresentation(probe: ScenarioProbeStatus) {
  return {
    label: verificationStatusLabel(probe.status),
    variant: isVerificationPassed(probe.status)
      ? ("success" as const)
      : ("destructive" as const),
  };
}

// Status never relies on color alone: each shape is paired with a visible
// status badge in the same row.
function StatusIcon({ status }: { status: string }) {
  if (isVerificationPassed(status)) {
    return (
      <CheckCircle2
        className="mt-0.5 size-4 shrink-0 text-success"
        aria-hidden="true"
      />
    );
  }
  return (
    <CircleAlert
      className="mt-0.5 size-4 shrink-0 text-destructive"
      aria-hidden="true"
    />
  );
}
