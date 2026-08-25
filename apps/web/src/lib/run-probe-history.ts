import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { scenarioRunProbeSnapshots, scenarioRuns } from "@/db/schema";
import { createAppId } from "@/lib/id";
import { isVerificationPassed } from "@/lib/verification-copy";
import type {
  RunStateDocument,
  RunVmStateDocument,
  ScenarioProbeStatus,
} from "@/lib/run-state";

// Probe-transition history for the run objective timeline. A snapshot row is
// written only when a VM's probe status vector changes between two persisted
// run states — heartbeats that re-report the same statuses produce no rows,
// so the table stays proportional to actual objective progress.

export interface ProbeTransitionRow {
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

// One status entry per probe, order-independent. A valid run-state report
// proves the observer is available, so raw value/error churn stays ignored.
export function probeStatusSignature(vm: {
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
}): string {
  const probes = [...vm.bootProbes, ...vm.scenarioProbes];
  const statuses = probes
    .map((probe) => `${probe.phase}:${probe.id}=${probe.status}`)
    .sort()
    .join("|");
  return statuses;
}

export function probeTransitionVms(
  current: RunStateDocument,
  next: RunStateDocument,
): RunVmStateDocument[] {
  const previousByVm = new Map(
    current.vms.map((vm) => [vm.id, probeStatusSignature(vm)]),
  );
  return next.vms.filter((vm) => {
    const hasProbes = vm.bootProbes.length + vm.scenarioProbes.length > 0;
    return hasProbes && previousByVm.get(vm.id) !== probeStatusSignature(vm);
  });
}

export async function recordProbeTransitions(
  db: DrizzleD1Database,
  params: {
    runId: string;
    current: RunStateDocument;
    next: RunStateDocument;
    observedAt: number;
  },
): Promise<void> {
  const changed = probeTransitionVms(params.current, params.next);
  if (!changed.length) {
    return;
  }

  await db
    .insert(scenarioRunProbeSnapshots)
    .values(
      changed.map((vm) => {
        const probes = [...vm.bootProbes, ...vm.scenarioProbes];
        const failing = probes.filter((probe) => probe.status === "fail");
        const passing = probes.filter((probe) =>
          isVerificationPassed(probe.status),
        );
        const observedAt = vm.runtimeObservedAt ?? params.observedAt;
        return {
          id: createAppId(),
          runId: params.runId,
          vmId: vm.id,
          runtimeVmName: vm.runtimeVmName,
          // The unique (runId, vmId, messageId) index dedups replays of the
          // same observation; one transition per VM per observed millisecond.
          messageId: String(observedAt),
          collectionState: vm.phase,
          collectionError: null,
          summaryJson: JSON.stringify({
            pass: passing.length,
            fail: failing.length,
            total: probes.length,
          }),
          snapshotJson: JSON.stringify(
            probes.map((probe) => ({
              id: probe.id,
              label: probe.label,
              kind: probe.kind,
              phase: probe.phase,
              status: probe.status,
            })),
          ),
          generatedAt: vm.runtimeObservedAt,
          observedAt,
        };
      }),
    )
    .onConflictDoNothing();
}

export async function listProbeSnapshotsForUserRun(
  db: DrizzleD1Database,
  params: { runId: string; userId: string },
): Promise<ProbeTransitionRow[] | null> {
  const runRows = await db
    .select({ runId: scenarioRuns.runId })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.runId, params.runId),
        eq(scenarioRuns.userId, params.userId),
      ),
    )
    .limit(1);
  if (!runRows.length) {
    return null;
  }

  const rows = await db
    .select({
      id: scenarioRunProbeSnapshots.id,
      vmId: scenarioRunProbeSnapshots.vmId,
      runtimeVmName: scenarioRunProbeSnapshots.runtimeVmName,
      observedAt: scenarioRunProbeSnapshots.observedAt,
      collectionState: scenarioRunProbeSnapshots.collectionState,
      collectionError: scenarioRunProbeSnapshots.collectionError,
      snapshotJson: scenarioRunProbeSnapshots.snapshotJson,
    })
    .from(scenarioRunProbeSnapshots)
    .where(eq(scenarioRunProbeSnapshots.runId, params.runId))
    .orderBy(asc(scenarioRunProbeSnapshots.observedAt))
    .limit(500);

  return rows.map((row) => {
    const probes = parseSnapshotProbes(row.snapshotJson);
    return {
      id: row.id,
      vmId: row.vmId,
      runtimeVmName: row.runtimeVmName,
      observedAt: row.observedAt,
      probes,
    };
  });
}

function parseSnapshotProbes(raw: string): ProbeTransitionRow["probes"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const probe = entry as Record<string, unknown>;
      return [
        {
          id: typeof probe.id === "string" ? probe.id : "",
          label: typeof probe.label === "string" ? probe.label : "",
          kind: typeof probe.kind === "string" ? probe.kind : "",
          phase: probe.phase === "boot" ? ("boot" as const) : ("scenario" as const),
          status: typeof probe.status === "string" ? probe.status : "unknown",
        },
      ];
    });
  } catch {
    return [];
  }
}
