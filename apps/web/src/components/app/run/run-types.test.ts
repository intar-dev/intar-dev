import { describe, expect, it } from "vitest";
import { HttpResponseError } from "@/components/app/lib/http-response-error";
import {
  mergeScenarioRunStatus,
  POLL_INTERVALS,
  scenarioRunStatusRefetchInterval,
  type ScenarioRunRecord,
  type ScenarioRunStatus,
} from "./run-types";

describe("scenario run polling", () => {
  it("uses adaptive detail intervals and stops in terminal phases", () => {
    expect(POLL_INTERVALS.launching).toBe(750);
    expect(POLL_INTERVALS.booting).toBe(750);
    expect(POLL_INTERVALS.running).toBe(1_500);
    expect(POLL_INTERVALS.deleting).toBe(1_000);
    expect(POLL_INTERVALS.archiving).toBe(1_000);
    expect(POLL_INTERVALS.completed).toBe(false);
    expect(POLL_INTERVALS.failed).toBe(false);
  });

  it("continues status polling after transient errors but stops for revoked access", () => {
    const liveRun = runRecord();

    expect(scenarioRunStatusRefetchInterval(liveRun, new Error("offline"))).toBe(
      1_500,
    );
    expect(
      scenarioRunStatusRefetchInterval(
        liveRun,
        new HttpResponseError(500, "server error"),
      ),
    ).toBe(1_500);
    expect(
      scenarioRunStatusRefetchInterval(
        liveRun,
        new HttpResponseError(401, "unauthorized"),
      ),
    ).toBe(false);
    expect(
      scenarioRunStatusRefetchInterval(
        liveRun,
        new HttpResponseError(404, "not found"),
      ),
    ).toBe(false);
  });
});

describe("scenario run status merge", () => {
  it("keeps full authored detail when a newer compact status arrives", () => {
    const current = runRecord();

    const next = mergeScenarioRunStatus(
      current,
      runStatus({
        updatedAt: 101,
        phase: "archiving",
        activity: "background",
        active: false,
        progressPercent: 94,
        savingStage: "preparing_replay",
        replayState: "preparing",
        vms: [
          {
            ...runStatus().vms[0]!,
            phase: "archived",
            progressPercent: 94,
            scenarioProbes: [
              {
                id: "probe-1",
                label: "Service check",
                kind: "http",
                phase: "scenario",
                status: "pass",
                error: null,
                value: { code: 200 },
              },
            ],
          },
        ],
      }),
    );

    expect(next).toMatchObject({
      id: "run-1",
      title: "Repair the service",
      briefingMarkdown: "Keep this authored work order.",
      hints: [{ key: "scenario:hint-1", revealed: false }],
      phase: "archiving",
      activity: "background",
      progressPercent: 94,
      savingStage: "preparing_replay",
    });
    expect(next.vms[0]).toMatchObject({
      id: "vm-1",
      scenarioVmName: "web",
      phase: "archiving",
      progressPercent: 94,
      scenarioProbes: [{ id: "probe-1", status: "pass" }],
    });
  });

  it("keeps the cached record for an unchanged or older status", () => {
    const current = runRecord();

    expect(mergeScenarioRunStatus(current, null)).toBe(current);
    expect(
      mergeScenarioRunStatus(current, runStatus({ updatedAt: 99 })),
    ).toBe(current);
  });
});

function runRecord(): ScenarioRunRecord {
  return {
    id: "run-1",
    scenarioId: "repair-service",
    organizationId: null,
    courseLocation: null,
    scenarioName: "repair-service",
    phase: "running",
    phaseTitle: "Running",
    phaseDetail: "Workspace is ready.",
    title: "Repair the service",
    tagline: "Fix the deployment",
    briefingMarkdown: "Keep this authored work order.",
    objectives: [
      {
        probeName: "probe-1",
        vmName: "web",
        label: "Service check",
        title: "Repair the service",
        bodyMarkdown: null,
        hintCount: 1,
      },
    ],
    tags: ["network"],
    hints: [
      {
        key: "scenario:hint-1",
        scope: "scenario",
        probeName: null,
        id: "hint-1",
        title: "A hint",
        revealed: false,
        unlocked: true,
        bodyMarkdown: null,
      },
    ],
    solution: {
      unlocked: false,
      revealed: false,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: null,
    },
    difficulty: "easy",
    estimatedMinutes: 15,
    solvedAt: null,
    solveDurationMs: null,
    outcome: "in_progress",
    active: true,
    activity: "foreground",
    deleteRequestedAt: null,
    savingStage: null,
    replayState: "not_started",
    hasReplay: false,
    progressPercent: 65,
    terminalPhase: "ready",
    canOpenTerminal: true,
    canDestroy: true,
    createdAt: 1,
    updatedAt: 100,
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    terminalTarget: terminalTarget(),
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "web",
        runtimeVmName: "run-web",
        hostname: "web.local",
        phase: "running",
        phaseTitle: "Running",
        phaseDetail: "Workspace is ready.",
        progressPercent: 65,
        terminalPhase: "ready",
        canOpenTerminal: true,
        bootProbes: [],
        scenarioProbes: [],
        replayArtifacts: [],
        sessionTimeline: null,
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
        terminalTarget: terminalTarget(),
      },
    ],
  };
}

function runStatus(overrides: Partial<ScenarioRunStatus> = {}): ScenarioRunStatus {
  return {
    version: "100",
    updatedAt: 100,
    phase: "active_full",
    phaseTitle: "Ready",
    phaseDetail: "Workspace is ready.",
    progressPercent: 65,
    terminalPhase: "ready",
    canOpenTerminal: true,
    canDestroy: true,
    terminalTarget: terminalTarget(),
    outcome: "in_progress",
    active: true,
    activity: "foreground",
    deleteRequestedAt: null,
    solvedAt: null,
    solveDurationMs: null,
    savingStage: null,
    replayState: "not_started",
    hasReplay: false,
    vms: [
      {
        id: "vm-1",
        phase: "ready",
        phaseTitle: "Ready",
        phaseDetail: "Workspace is ready.",
        progressPercent: 65,
        terminalPhase: "ready",
        canOpenTerminal: true,
        terminalTarget: terminalTarget(),
        bootProbes: [],
        scenarioProbes: [],
        sessionTimeline: null,
      },
    ],
    ...overrides,
  };
}

function terminalTarget() {
  return {
    host: "203.0.113.10",
    port: 22,
    username: "root",
    hostKeyOpenssh: "ssh-ed25519 AAAA",
    checkedAt: 100,
  };
}
