import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
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
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  const passed = props.probes.filter((probe) =>
    isVerificationPassed(probe.status),
  ).length;
  const total = props.probes.length;
  const verificationUnavailable = props.probes.some(
    (probe) =>
      !isVerificationPassed(probe.status) &&
      (probe.status.trim().toLowerCase() === "error" ||
        Boolean(probe.error?.trim())),
  );

  return (
    <section aria-labelledby="repair-objectives-heading">
      <div className="flex items-center justify-between gap-3">
        <p id="repair-objectives-heading" className="text-eyebrow">
          Objectives
        </p>
        {total ? (
          <span
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
            aria-label={`${passed} of ${total} objectives verified`}
          >
            {passed}/{total} verified
          </span>
        ) : null}
      </div>
      {verificationUnavailable ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Verification unavailable. We cannot confirm all progress right now.
        </p>
      ) : null}
      {total ? (
        <ol className="mt-3 divide-y border-y">
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
  const passed = isVerificationPassed(probe.status);

  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 py-3">
      <StatusIcon status={probe.status} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {!passed && objective?.bodyMarkdown ? (
          <Markdown className="max-w-[68ch] space-y-1 text-sm leading-5 text-muted-foreground">
            {objective.bodyMarkdown}
          </Markdown>
        ) : null}
      </div>
      <span
        className={`pt-0.5 text-xs font-medium whitespace-nowrap ${
          passed ? "text-success" : "text-destructive"
        }`}
      >
        {verificationStatusLabel(probe.status)}
      </span>
    </li>
  );
}

// Status never relies on color alone: each icon is paired with visible text.
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
