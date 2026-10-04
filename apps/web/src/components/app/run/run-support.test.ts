import { describe, expect, it } from "vitest";
import {
  buildScenarioBootSteps,
  hasPendingInfrastructureTeardown,
} from "./run-support";
import type {
  ScenarioProbeStatus,
  ScenarioRunRecord,
  ScenarioRunVmRecord,
} from "./run-types";

describe("hasPendingInfrastructureTeardown", () => {
  it("keeps every unfinished VM destroyable", () => {
    expect(
      hasPendingInfrastructureTeardown([
        { phase: "failed" },
        { phase: "deleting" },
      ]),
    ).toBe(true);
  });

  it("does not treat a failed VM as teardown-complete", () => {
    expect(hasPendingInfrastructureTeardown([{ phase: "failed" }])).toBe(true);
  });

  it("allows archival deletion only after every VM is completed", () => {
    expect(hasPendingInfrastructureTeardown([{ phase: "completed" }])).toBe(
      false,
    );
  });
});

describe("scenario startup milestones", () => {
  it("uses truthful named milestones without numeric progress", () => {
    const vm = runVm({ phase: "booting" });
    const steps = buildScenarioBootSteps(run([vm]), vm);

    expect(steps.map((step) => step.label)).toEqual([
      "Creating your run",
      "Starting your workspace",
      "Checking the workspace",
      "Opening the shell",
    ]);
    expect(steps.map((step) => step.state)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it.each([
    ["nothing reported", [], false, 1],
    ["boot checks incomplete", [probe("pending", "boot-a"), probe("fail", "boot-b")], false, 2],
    ["boot checks passed", [probe("pass", "boot-a")], true, 3],
  ])(
    "fails only the one stage that was working when the machine failed: %s",
    (_name, bootProbes, canOpenTerminal, failedAt) => {
      const vm = { ...runVm({ phase: "failed" }), bootProbes, canOpenTerminal };
      const steps = buildScenarioBootSteps(run([vm]), vm);

      expect(steps.filter((step) => step.state === "failed")).toHaveLength(1);
      expect(steps[failedAt]?.state).toBe("failed");
      expect(steps.slice(0, failedAt).every((step) => step.state === "done")).toBe(
        true,
      );
      expect(
        steps.slice(failedAt + 1).every((step) => step.state === "pending"),
      ).toBe(true);
      expect(steps[failedAt]?.detail).toMatch(/could not|did not/);
    },
  );

  it("tracks the selected machine independently in a multi-VM run", () => {
    const ready = runVm({ id: "vm-ready", phase: "running", ready: true });
    const booting = runVm({ id: "vm-booting", phase: "booting" });

    const readySteps = buildScenarioBootSteps(run([ready, booting]), ready);
    const bootingSteps = buildScenarioBootSteps(run([ready, booting]), booting);

    expect(readySteps.at(-1)?.state).toBe("done");
    expect(bootingSteps.at(-1)?.state).toBe("pending");
  });
});

function run(
  vms: ScenarioRunVmRecord[],
  overrides: Partial<ScenarioRunRecord> = {},
): ScenarioRunRecord {
  return {
    id: "run-1",
    phase: "booting",
    canOpenTerminal: vms.some((vm) => vm.canOpenTerminal),
    bootProbes: vms.flatMap((vm) => vm.bootProbes),
    scenarioProbes: [],
    vms,
    replayState: "not_started",
    activity: "foreground",
    ...overrides,
  } as ScenarioRunRecord;
}

function probe(status: string, id: string): ScenarioProbeStatus {
  return {
    id,
    label: id,
    kind: "tcp",
    phase: "boot",
    status,
    error: null,
    value: null,
  };
}

function runVm(input: {
  id?: string;
  phase: ScenarioRunVmRecord["phase"];
  ready?: boolean;
}): ScenarioRunVmRecord {
  return {
    id: input.id ?? "vm-1",
    ordinal: 0,
    scenarioVmId: "scenario-vm-1",
    scenarioVmName: "web",
    runtimeVmName: "runtime-web",
    hostname: "web",
    phase: input.phase,
    phaseTitle: input.phase,
    phaseDetail: "Fixture machine state",
    progressPercent: 0,
    canOpenTerminal: input.ready ?? false,
    terminalPhase: input.ready ? "ready" : "pending",
    terminalTarget: {
      host: input.ready ? "203.0.113.1" : null,
      port: input.ready ? 22 : 0,
      username: "root",
      hostKeyOpenssh: null,
      checkedAt: null,
    },
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
  };
}
