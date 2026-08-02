import { describe, expect, it } from "vitest";
import type { ProbeSnapshotRow } from "./probe-pass-times";
import {
  buildRunTimelineItems,
  deriveVmRecordingState,
} from "./run-timeline-model";
import type {
  ScenarioRunRecord,
  ScenarioRunVmRecord,
  SessionTimelineEntry,
} from "./run-types";

describe("run timeline model", () => {
  it("merges run, check, session, solve, and shutdown events oldest first", () => {
    const vm = runVm({
      phase: "completed",
      sessions: [session({ startTimestampMs: 2_500 })],
      hasRecording: true,
    });
    const run = scenarioRun([vm], {
      phase: "completed",
      createdAt: 1_000,
      solvedAt: 4_000,
      solveDurationMs: 3_000,
      deleteRequestedAt: 5_000,
      updatedAt: 6_000,
    });
    const snapshots = [
      snapshot("later", 3_000, [
        probe("service", "Service responds", "pass"),
        probe("disk", "Disk is writable", "pass"),
      ]),
      snapshot("first", 2_000, [
        probe("service", "Service responds", "fail"),
        probe("disk", "Disk is writable", "pass"),
      ]),
    ];

    const items = buildRunTimelineItems(run, snapshots);

    expect(items.map((item) => item.type)).toEqual([
      "run_started",
      "probe_changes",
      "session",
      "probe_changes",
      "solved",
      "shutdown_requested",
      "lifecycle",
    ]);
    expect(items.map((item) => item.at)).toEqual([
      1_000, 2_000, 2_500, 3_000, 4_000, 5_000, 6_000,
    ]);

    const laterProbe = items.find((item) => item.id === "probe:later");
    expect(laterProbe).toMatchObject({
      type: "probe_changes",
      vmName: "web",
      changes: [
        {
          probeId: "service",
          from: "fail",
          to: "pass",
        },
      ],
    });
  });

  it("uses deterministic type ordering when events share a timestamp", () => {
    const vm = runVm({
      phase: "completed",
      sessions: [session({ startTimestampMs: 2_000 })],
      hasRecording: true,
    });
    const items = buildRunTimelineItems(
      scenarioRun([vm], { phase: "completed", updatedAt: 3_000 }),
      [snapshot("snapshot-1", 2_000, [probe("check", "Check", "pass")])],
    );

    expect(
      items.filter((item) => item.at === 2_000).map((item) => item.type),
    ).toEqual(["probe_changes", "session"]);
  });

  it("keeps current unknown-time work at the end without inventing a timestamp", () => {
    const run = scenarioRun(
      [runVm({ phase: "archiving", hasRecording: true })],
      {
        phase: "archiving",
        deleteRequestedAt: 4_000,
        updatedAt: 5_000,
      },
    );

    const items = buildRunTimelineItems(run, []);

    expect(items.slice(-2)).toMatchObject([
      {
        type: "recording_status",
        state: "rendering",
        at: null,
        current: true,
      },
      {
        type: "lifecycle",
        phase: "archiving",
        at: null,
        current: true,
      },
    ]);
  });

  it("derives recording finality per machine in a mixed archival run", () => {
    const vms = [
      runVm({ id: "none", phase: "completed", hasRecording: false }),
      runVm({ id: "broken", phase: "failed", hasRecording: true }),
      runVm({ id: "waiting", phase: "archiving", hasRecording: false }),
      runVm({ id: "rendering", phase: "archiving", hasRecording: true }),
      runVm({
        id: "ready",
        phase: "completed",
        hasRecording: true,
        sessions: [session()],
      }),
    ];

    expect(vms.map((vm) => deriveVmRecordingState(vm))).toEqual([
      "none",
      "unavailable",
      "preparing",
      "rendering",
      "ready",
    ]);

    const statusItems = buildRunTimelineItems(
      scenarioRun(vms, { phase: "archiving" }),
      [],
    ).filter((item) => item.type === "recording_status");
    expect(statusItems.map((item) => [item.vmId, item.state])).toEqual([
      ["broken", "unavailable"],
      ["none", "none"],
      ["rendering", "rendering"],
      ["waiting", "preparing"],
    ]);
    expect(statusItems.every((item) => item.at === null)).toBe(true);
  });

  it("marks a missing cast from machine finality, not the aggregate phase", () => {
    const sessionWithoutCast = session({ castArtifactId: null });
    const completedVm = runVm({
      id: "done",
      phase: "completed",
      sessions: [sessionWithoutCast],
      hasRecording: true,
    });
    const archivingVm = runVm({
      id: "working",
      phase: "archiving",
      sessions: [sessionWithoutCast],
      hasRecording: true,
    });

    const sessions = buildRunTimelineItems(
      scenarioRun([completedVm, archivingVm], { phase: "archiving" }),
      [],
    ).filter((item) => item.type === "session");

    expect(
      sessions.map((item) => [item.vmId, item.replayAvailability]),
    ).toEqual([
      ["done", "unavailable"],
      ["working", "pending"],
    ]);
  });

  it("renders terminal failures as final danger events with the phase detail", () => {
    const items = buildRunTimelineItems(
      scenarioRun([runVm({ phase: "failed" })], {
        phase: "failed",
        phaseDetail: "The host stopped responding.",
        updatedAt: 7_000,
      }),
      [],
    );

    expect(items.at(-1)).toMatchObject({
      type: "lifecycle",
      at: 7_000,
      tone: "danger",
      current: false,
      title: "Run ended with an error",
      detail: "The host stopped responding.",
    });
  });
});

function scenarioRun(
  vms: ScenarioRunVmRecord[],
  overrides: Partial<ScenarioRunRecord> = {},
): ScenarioRunRecord {
  return {
    id: "run-1",
    scenarioId: "scenario-1",
    scenarioName: "Repair the service",
    phase: "completed",
    phaseTitle: "Completed",
    phaseDetail: "Run reconciliation completed.",
    title: "Repair the service",
    tagline: "Restore service health.",
    briefingMarkdown: "Fix it.",
    objectives: [],
    tags: [],
    hints: [],
    solution: {
      unlocked: false,
      revealed: false,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: null,
    },
    difficulty: "easy",
    estimatedMinutes: 10,
    solvedAt: null,
    solveDurationMs: null,
    outcome: "cancelled",
    active: false,
    activity: "settled",
    deleteRequestedAt: null,
    replayState: "none",
    hasReplay: false,
    progressPercent: 100,
    terminalPhase: "ready",
    canOpenTerminal: false,
    canDestroy: false,
    createdAt: 1_000,
    updatedAt: 9_000,
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    vms,
    ...overrides,
  };
}

function runVm({
  id = "vm-1",
  phase,
  hasRecording,
  sessions = null,
}: {
  id?: string;
  phase: ScenarioRunVmRecord["phase"];
  hasRecording?: boolean;
  sessions?: SessionTimelineEntry[] | null;
}): ScenarioRunVmRecord {
  return {
    id,
    ordinal: 0,
    scenarioVmId: `scenario-${id}`,
    scenarioVmName: id === "vm-1" ? "web" : id,
    runtimeVmName: `runtime-${id}`,
    hostname: id,
    phase,
    phaseTitle: phase,
    phaseDetail: "Machine state",
    progressPercent: 100,
    terminalPhase: "ready",
    canOpenTerminal: false,
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    sessionTimeline: sessions,
    ...(hasRecording === undefined ? {} : { hasRecording }),
    provisioning: {
      image: null,
      imageKey: null,
      imageSha256: null,
      resources: null,
      leaseDurationSeconds: null,
      groupName: null,
      groupId: null,
      setupKeyId: null,
      status: "pending",
      error: null,
    },
    terminalTarget: {
      host: null,
      port: 22,
      username: "root",
      hostKeyOpenssh: null,
      checkedAt: null,
    },
  };
}

function session(
  overrides: Partial<SessionTimelineEntry> = {},
): SessionTimelineEntry {
  return {
    index: 1,
    startTimestampMs: 2_000,
    durationMs: 1_000,
    exitCode: 0,
    castFilename: "session-01.cast",
    castArtifactId: "cast-1",
    transcriptTruncated: false,
    ...overrides,
  };
}

function snapshot(
  id: string,
  observedAt: number,
  probes: ProbeSnapshotRow["probes"],
): ProbeSnapshotRow {
  return {
    id,
    vmId: "vm-1",
    runtimeVmName: "runtime-vm-1",
    observedAt,
    probes,
  };
}

function probe(
  id: string,
  label: string,
  status: string,
): ProbeSnapshotRow["probes"][number] {
  return {
    id,
    label,
    kind: "command",
    phase: "scenario",
    status,
  };
}
