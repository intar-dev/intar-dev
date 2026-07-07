import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { formatTimestamp } from "../lib/format";
import { cn } from "@/lib/utils";

interface ProbeTransitionRow {
  id: string;
  vmId: string;
  runtimeVmName: string;
  observedAt: number;
  probes: Array<{
    id: string;
    label: string;
    kind: string;
    phase: "boot" | "scenario";
    status: string;
  }>;
}

interface ProbeSnapshotsResponse {
  snapshots: ProbeTransitionRow[];
}

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
function toTimelineEvents(rows: ProbeTransitionRow[]): TimelineEvent[] {
  const lastByVm = new Map<string, Map<string, string>>();
  const events: TimelineEvent[] = [];

  for (const row of rows) {
    const previous = lastByVm.get(row.vmId);
    const nextStatuses = new Map(
      row.probes.map((probe) => [probe.id, probe.status]),
    );
    const changes: ProbeChange[] = row.probes
      .filter((probe) => previous?.get(probe.id) !== probe.status)
      .map((probe) => ({
        probeId: probe.id,
        label: probe.label,
        from: previous?.get(probe.id) ?? null,
        to: probe.status,
      }));
    lastByVm.set(row.vmId, nextStatuses);
    if (changes.length) {
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
export function ObjectiveTimeline({ runId }: { runId: string }) {
  const snapshots = useQuery({
    queryKey: ["scenario-run", runId, "probe-snapshots"],
    queryFn: async () => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/probe-snapshots`,
        { method: "GET", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load timeline (${response.status})`,
        );
      }
      return (await response.json()) as ProbeSnapshotsResponse;
    },
    staleTime: 15_000,
  });

  if (snapshots.isLoading) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        Loading timeline…
      </p>
    );
  }

  if (snapshots.error) {
    return (
      <p className="px-1 py-2 text-xs text-destructive">
        {snapshots.error instanceof Error
          ? snapshots.error.message
          : "Failed to load timeline"}
      </p>
    );
  }

  const events = toTimelineEvents(snapshots.data?.snapshots ?? []);
  if (!events.length) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        No probe changes recorded yet. Progress shows up here as checks flip.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {events.map((event) => (
        <li key={event.id} className="space-y-1 text-xs">
          <p className="text-muted-foreground">
            <span className="tabular-nums">
              {formatTimestamp(event.observedAt)}
            </span>
            <span className="mx-1.5">·</span>
            <span className="font-medium text-foreground">{event.vmName}</span>
          </p>
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
        </li>
      ))}
    </ol>
  );
}

function StatusText({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "font-medium",
        status === "pass"
          ? "text-success"
          : status === "fail"
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}
