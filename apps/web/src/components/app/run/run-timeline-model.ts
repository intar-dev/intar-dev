import type { ProbeSnapshotRow } from "./probe-pass-times";
import {
  buildVerificationLabelMap,
  isVerificationPassed,
} from "@/lib/verification-copy";
import { formatScenarioDurationMs } from "./run-support";
import type {
  ScenarioRunRecord,
  ScenarioRunVmRecord,
  SessionTimelineEntry,
} from "./run-types";

export type RunTimelineTone = "neutral" | "pending" | "success" | "danger";

export interface RunTimelineProbeChange {
  probeId: string;
  label: string;
  from: string | null;
  to: string;
}

export type ProbeProgressSummary = "Verified" | "Needs repair";

interface RunTimelineItemBase {
  id: string;
  /** Null means this item has no trustworthy event timestamp. */
  at: number | null;
  tone: RunTimelineTone;
}

export type RunTimelineItem =
  | (RunTimelineItemBase & {
      type: "run_started";
    })
  | (RunTimelineItemBase & {
      type: "probe_changes";
      vmId: string;
      vmName: string;
      changes: RunTimelineProbeChange[];
      summary: ProbeProgressSummary;
      verificationUnavailable: boolean;
    })
  | (RunTimelineItemBase & {
      type: "session";
      vmId: string;
      vmName: string;
      session: SessionTimelineEntry;
      sessionNumber: number;
      sessionCount: number;
      replayAvailability: "ready" | "pending" | "unavailable";
    })
  | (RunTimelineItemBase & {
      type: "solved";
      durationMs: number | null;
    })
  | (RunTimelineItemBase & {
      type: "shutdown_requested";
    })
  | (RunTimelineItemBase & {
      type: "recording_status";
      vmId: string;
      vmName: string;
      state: Exclude<VmRecordingState, "ready">;
      current: boolean;
      /** Orders a terminal status beside the final run update without
       * presenting that update time as the recording's own timestamp. */
      sortAt: number;
    })
  | (RunTimelineItemBase & {
      type: "lifecycle";
      phase: ScenarioRunRecord["phase"];
      title: string;
      detail: string;
      current: boolean;
    });

export type VmRecordingState =
  | "preparing"
  | "rendering"
  | "ready"
  | "none"
  | "unavailable";

export function deriveVmRecordingState(
  vm: Pick<ScenarioRunVmRecord, "hasRecording" | "sessionTimeline" | "phase">,
): VmRecordingState {
  if (vm.sessionTimeline?.length) {
    return "ready";
  }

  const terminal = isTerminal(vm.phase);
  if (!terminal) {
    return vm.hasRecording === true ? "rendering" : "preparing";
  }

  return vm.hasRecording === true ? "unavailable" : "none";
}

/**
 * Combines persisted run state, probe snapshots, and session metadata into one
 * deterministic chronological stream. Unknown recording/lifecycle timestamps
 * deliberately remain null and sort last instead of being approximated.
 */
export function buildRunTimelineItems(
  run: ScenarioRunRecord,
  probeSnapshots: readonly ProbeSnapshotRow[],
): RunTimelineItem[] {
  const items: RunTimelineItem[] = [
    {
      id: "run-started",
      type: "run_started",
      at: run.createdAt,
      tone: "neutral",
    },
  ];

  items.push(...buildProbeItems(run, probeSnapshots));

  for (const vm of run.vms) {
    const sessions = vm.sessionTimeline ?? [];
    const orderedSessions = [...sessions].sort(
      (left, right) =>
        left.startTimestampMs - right.startTimestampMs ||
        left.index - right.index,
    );

    for (const [position, session] of orderedSessions.entries()) {
      items.push({
        id: `session:${vm.id}:${session.index}`,
        type: "session",
        at: session.startTimestampMs,
        tone:
          terminalSessionTone(session.exitCode),
        vmId: vm.id,
        vmName: machineName(vm),
        session,
        sessionNumber: position + 1,
        sessionCount: orderedSessions.length,
        replayAvailability: session.castArtifactId
          ? "ready"
          : isTerminal(vm.phase)
            ? "unavailable"
            : "pending",
      });
    }

    const recordingState = deriveVmRecordingState(vm);
    if (recordingState !== "ready") {
      const terminal = isTerminal(vm.phase);
      items.push({
        id: `recording:${vm.id}`,
        type: "recording_status",
        // Recording preparation has no independent timestamp in the wire
        // model. Keep it visibly untimed rather than borrowing run.updatedAt.
        at: null,
        tone:
          recordingState === "unavailable"
            ? "danger"
            : recordingState === "none"
              ? "neutral"
              : "pending",
        vmId: vm.id,
        vmName: machineName(vm),
        state: recordingState,
        current: !terminal,
        sortAt: terminal ? run.updatedAt : Number.POSITIVE_INFINITY,
      });
    }
  }

  if (run.solvedAt !== null) {
    items.push({
      id: "objectives-solved",
      type: "solved",
      at: run.solvedAt,
      tone: "success",
      durationMs: run.solveDurationMs,
    });
  }

  if (run.deleteRequestedAt !== null) {
    items.push({
      id: "shutdown-requested",
      type: "shutdown_requested",
      at: run.deleteRequestedAt,
      tone: "neutral",
    });
  }

  items.push(buildLifecycleItem(run));

  return items.sort(compareTimelineItems);
}

function buildProbeItems(
  run: ScenarioRunRecord,
  probeSnapshots: readonly ProbeSnapshotRow[],
): RunTimelineItem[] {
  const lastByVm = new Map<string, Map<string, string>>();
  const lastUnavailableByVm = new Map<string, boolean>();
  const vmNames = new Map(
    run.vms.map((vm) => [vm.id, machineName(vm)] as const),
  );
  const items: RunTimelineItem[] = [];
  const rows = [...probeSnapshots].sort(
    (left, right) =>
      left.observedAt - right.observedAt || left.id.localeCompare(right.id),
  );
  const allProbes = rows.flatMap((row) => row.probes);
  const labels = buildVerificationLabelMap({
    bootProbeIds: allProbes
      .filter((probe) => probe.phase === "boot")
      .map((probe) => probe.id),
    scenarioProbeIds: allProbes
      .filter((probe) => probe.phase === "scenario")
      .map((probe) => probe.id),
    objectives: run.objectives,
  });

  for (const row of rows) {
    const previous = lastByVm.get(row.vmId);
    const previousUnavailable = lastUnavailableByVm.get(row.vmId) ?? false;
    const verificationUnavailable = Boolean(
      row.verificationUnavailable ||
        row.probes.some(
          (probe) => probe.status.trim().toLowerCase() === "error",
        ),
    );
    const availabilityBecameUnavailable =
      verificationUnavailable && !previousUnavailable;
    const next = new Map(row.probes.map((probe) => [probe.id, probe.status]));
    const changes = row.probes
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

    lastByVm.set(row.vmId, next);
    lastUnavailableByVm.set(row.vmId, verificationUnavailable);
    const summary = summarizeProbeProgress(
      row.probes.map((probe) => probe.status),
    );
    const initialUnreportedOnly =
      !previous && changes.length > 0 && changes.every(isUnreportedStatus);
    if (
      (!changes.length && !availabilityBecameUnavailable) ||
      (initialUnreportedOnly && !availabilityBecameUnavailable)
    ) {
      continue;
    }

    items.push({
      id: `probe:${row.id}`,
      type: "probe_changes",
      at: row.observedAt,
      tone: probeProgressTone(summary),
      vmId: row.vmId,
      vmName: vmNames.get(row.vmId) ?? row.runtimeVmName,
      changes,
      summary,
      verificationUnavailable,
    });
  }

  return items;
}

function isUnreportedStatus(change: RunTimelineProbeChange): boolean {
  const status = change.to.trim().toLowerCase();
  return (
    !isVerificationPassed(status) && status !== "fail" && status !== "error"
  );
}

function summarizeProbeProgress(
  statuses: readonly string[],
): ProbeProgressSummary {
  if (statuses.length && statuses.every(isVerificationPassed)) {
    return "Verified";
  }
  return "Needs repair";
}

function probeProgressTone(summary: ProbeProgressSummary): RunTimelineTone {
  switch (summary) {
    case "Verified":
      return "success";
    case "Needs repair":
      return "danger";
  }
}

export function terminalSessionTone(
  exitCode: number | null,
): RunTimelineTone {
  return exitCode !== null && exitCode !== 0 && exitCode !== 129
    ? "danger"
    : "neutral";
}

export function terminalSessionSummary(
  session: Pick<SessionTimelineEntry, "durationMs" | "exitCode">,
): string {
  const duration = formatScenarioDurationMs(session.durationMs);
  if (session.exitCode === null) {
    return `${duration} · Exit status was not recorded.`;
  }
  if (session.exitCode === 0) return `${duration} · Exited cleanly.`;
  if (session.exitCode === 129) {
    return `${duration} · Terminal session was recorded and closed during workspace cleanup.`;
  }
  return `${duration} · Terminal session ended unexpectedly (exit code ${session.exitCode}). Check the transcript or replay for details.`;
}

function buildLifecycleItem(run: ScenarioRunRecord): RunTimelineItem {
  switch (run.phase) {
    case "deleting":
      return {
        id: "run-lifecycle",
        type: "lifecycle",
        at: null,
        tone: "pending",
        phase: run.phase,
        title: "Shutting down workspace",
        detail:
          run.phaseDetail ||
          "Revoking shell access and removing the workspace.",
        current: true,
      };
    case "archiving":
      return {
        id: "run-lifecycle",
        type: "lifecycle",
        at: null,
        tone: "pending",
        phase: run.phase,
        title: "Saving run history",
        detail:
          run.phaseDetail || "Saving checks, logs, and terminal recordings.",
        current: true,
      };
    case "completed":
      return {
        id: "run-lifecycle",
        type: "lifecycle",
        at: run.updatedAt,
        tone:
          run.outcome === "succeeded"
            ? "success"
            : run.outcome === "failed"
              ? "danger"
              : "neutral",
        phase: run.phase,
        title: "Run saved",
        detail: "Run history and available artifacts are saved.",
        current: false,
      };
    case "failed":
      return {
        id: "run-lifecycle",
        type: "lifecycle",
        at: run.updatedAt,
        tone: "danger",
        phase: run.phase,
        title: "Run ended with an error",
        detail: run.phaseDetail || "The run could not be completed.",
        current: false,
      };
    default:
      return {
        id: "run-lifecycle",
        type: "lifecycle",
        at: null,
        tone: "pending",
        phase: run.phase,
        title: run.phaseTitle,
        detail: run.phaseDetail,
        current: true,
      };
  }
}

function compareTimelineItems(
  left: RunTimelineItem,
  right: RunTimelineItem,
): number {
  const leftTime = left.at ?? Number.POSITIVE_INFINITY;
  const rightTime = right.at ?? Number.POSITIVE_INFINITY;
  const leftSortTime =
    left.type === "recording_status" ? left.sortAt : leftTime;
  const rightSortTime =
    right.type === "recording_status" ? right.sortAt : rightTime;
  return (
    leftSortTime - rightSortTime ||
    itemPriority(left) - itemPriority(right) ||
    left.id.localeCompare(right.id)
  );
}

function itemPriority(item: RunTimelineItem): number {
  switch (item.type) {
    case "run_started":
      return 0;
    case "probe_changes":
      return 10;
    case "session":
      return 20;
    case "solved":
      return 30;
    case "shutdown_requested":
      return 40;
    case "recording_status":
      return 50;
    case "lifecycle":
      return 60;
  }
}

function machineName(
  vm: Pick<ScenarioRunVmRecord, "scenarioVmName" | "runtimeVmName">,
): string {
  return vm.scenarioVmName || vm.runtimeVmName;
}

function isTerminal(phase: ScenarioRunRecord["phase"]): boolean {
  return phase === "completed" || phase === "failed";
}
