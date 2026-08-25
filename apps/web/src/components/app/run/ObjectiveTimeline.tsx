import { ArrowRight } from "lucide-react";
import { formatTimestamp } from "../lib/format";
import { cn } from "@/lib/utils";
import {
  buildVerificationLabelMap,
  isVerificationPassed,
  verificationStatusLabel,
} from "@/lib/verification-copy";
import { useProbeSnapshots, type ProbeSnapshotRow } from "./probe-pass-times";
import type { ScenarioObjective } from "./run-types";

interface ProbeChange {
  probeId: string;
  label: string;
  from: string | null;
  to: string;
}

interface TimelineEvent {
  id: string;
  vmName: string;
  observedAt: number;
  changes: ProbeChange[];
}

// Diff consecutive snapshots per VM into "probe X: fail → pass" events.
export function toTimelineEvents(
  rows: ProbeSnapshotRow[],
  objectives: ScenarioObjective[],
): TimelineEvent[] {
  const lastByVm = new Map<string, Map<string, string>>();
  const events: TimelineEvent[] = [];
  const allProbes = rows.flatMap((row) => row.probes);
  const labels = buildVerificationLabelMap({
    bootProbeIds: allProbes
      .filter((probe) => probe.phase === "boot")
      .map((probe) => probe.id),
    scenarioProbeIds: allProbes
      .filter((probe) => probe.phase === "scenario")
      .map((probe) => probe.id),
    objectives,
  });

  for (const row of rows) {
    const previous = lastByVm.get(row.vmId);
    const nextStatuses = new Map(
      row.probes.map((probe) => [probe.id, probe.status]),
    );
    const changes: ProbeChange[] = row.probes
      .filter((probe) => {
        const before = previous?.get(probe.id);
        return (
          before === undefined ||
          isVerificationPassed(before) !==
            isVerificationPassed(probe.status)
        );
      })
      .map((probe) => ({
        probeId: probe.id,
        label: labels[probe.id] ?? "Verification objective",
        from: previous?.get(probe.id) ?? null,
        to: probe.status,
      }));
    lastByVm.set(row.vmId, nextStatuses);
    const initialUnreportedOnly =
      !previous &&
      changes.length > 0 &&
      changes.every((change) => isUnreportedStatus(change.to));
    if (changes.length && !initialUnreportedOnly) {
      events.push({
        id: row.id,
        vmName: row.runtimeVmName,
        observedAt: row.observedAt,
        changes,
      });
    }
  }

  return events.reverse();
}

// Only mounted when the timeline section is expanded, so the fetch stays off
// the run page's hot polling path.
export function ObjectiveTimeline({
  runId,
  objectives,
}: {
  runId: string;
  objectives: ScenarioObjective[];
}) {
  const snapshots = useProbeSnapshots(runId);

  if (snapshots.isLoading) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        Loading timeline…
      </p>
    );
  }

  if (snapshots.error) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        The progress timeline is temporarily unavailable. Try again soon.
      </p>
    );
  }

  const events = toTimelineEvents(
    snapshots.data?.snapshots ?? [],
    objectives,
  );
  if (!events.length) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        No objective changes recorded yet. Progress will appear here as repairs
        are verified.
      </p>
    );
  }

  return (
    <ol className="divide-y">
      {events.map((event) => (
        <li key={event.id} className="space-y-2 py-3 text-xs">
          <p className="text-muted-foreground">
            <span className="tabular-nums">
              {formatTimestamp(event.observedAt)}
            </span>
            <span className="mx-1.5">·</span>
            <span className="font-medium text-foreground">{event.vmName}</span>
          </p>
          {event.changes.length ? (
            <ul className="space-y-0.5">
              {event.changes.map((change) => (
              <li
                key={change.probeId}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="min-w-0 truncate">{change.label}</span>
                {change.from ? (
                  <>
                    <StatusText status={change.from} />
                    <ArrowRight
                      className="size-3 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </>
                ) : null}
                <StatusText status={change.to} />
              </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function StatusText({ status }: { status: string }) {
  const verified = isVerificationPassed(status);
  return (
    <span
      className={cn(
        "font-medium",
        verified ? "text-success" : "text-destructive",
      )}
    >
      {verificationStatusLabel(status)}
    </span>
  );
}

function isUnreportedStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return (
    !isVerificationPassed(normalized) &&
    !["fail", "error"].includes(normalized)
  );
}
