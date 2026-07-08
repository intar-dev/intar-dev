import { useQuery } from "@tanstack/react-query";

export interface ProbeSnapshotRow {
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

export interface ProbeSnapshotsResponse {
  snapshots: ProbeSnapshotRow[];
}

// Shared probe-snapshots fetch (ObjectiveTimeline + ResolutionCard). Only
// mounted components fetch, keeping it off the run page's hot polling path.
export function useProbeSnapshots(runId: string) {
  return useQuery({
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
}

// First time each scenario probe was observed passing, keyed by probe id.
export function firstPassTimes(rows: ProbeSnapshotRow[]): Map<string, number> {
  const passedAt = new Map<string, number>();
  for (const row of rows) {
    for (const probe of row.probes) {
      if (probe.phase !== "scenario" || probe.status !== "pass") {
        continue;
      }
      if (!passedAt.has(probe.id)) {
        passedAt.set(probe.id, row.observedAt);
      }
    }
  }
  return passedAt;
}
