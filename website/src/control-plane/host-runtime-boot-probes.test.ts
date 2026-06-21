import { describe, expect, it } from "vitest";
import {
  applyProbePhaseHeuristics,
  bootProbesPassing,
  shouldQueueTerminalStateGet,
} from "@/control-plane/host-runtime-boot-probes";
import { buildInitialVmState, decorateVmState } from "@/lib/run-state";
import type { ScenarioLaunchSummary } from "@/lib/scenario-model";

describe("host runtime boot probe gating", () => {
  it("treats missing boot probes as boot-ready", () => {
    const vm = buildVm({
      phase: "booting",
      bootProbeStatuses: [],
      scenarioProbeStatuses: ["pending"],
    });

    expect(bootProbesPassing(vm)).toBe(true);
  });

  it("queues terminal refreshes for bootless pending VMs when boot gating is required", () => {
    const vm = buildVm({
      phase: "booting",
      bootProbeStatuses: [],
      scenarioProbeStatuses: ["pending"],
    });

    expect(shouldQueueTerminalStateGet(vm, true)).toBe(true);
  });

  it("does not queue gated terminal refreshes while configured boot probes are still pending", () => {
    const vm = buildVm({
      phase: "booting",
      bootProbeStatuses: ["pending"],
      scenarioProbeStatuses: ["pending"],
    });

    expect(bootProbesPassing(vm)).toBe(false);
    expect(shouldQueueTerminalStateGet(vm, true)).toBe(false);
  });

  it("promotes bootless VMs to ready and preserves later terminal readiness", () => {
    const bootlessVm = buildVm({
      phase: "booting",
      bootProbeStatuses: [],
      scenarioProbeStatuses: ["pending"],
    });

    const afterProbe = applyProbePhaseHeuristics(bootlessVm);
    expect(afterProbe.phase).toBe("ready");
    expect(afterProbe.canOpenTerminal).toBe(false);
    expect(afterProbe.phaseDetail).toBe(
      "Boot probes passed. Waiting for shell target.",
    );

    const afterTerminal = applyProbePhaseHeuristics(
      decorateVmState({
        ...afterProbe,
        terminalPhase: "ready",
        terminalObservedAt: 123,
        terminalTarget: {
          host: "bridge.example.test",
          port: 2222,
          username: "ubuntu",
          checkedAt: 123,
        },
      }),
    );
    expect(afterTerminal.phase).toBe("ready");
    expect(afterTerminal.canOpenTerminal).toBe(true);
    expect(afterTerminal.phaseDetail).toBe(
      "Boot probes passed. Shell target is ready.",
    );
  });

  it("keeps VMs with non-passing boot probes in booting", () => {
    const vm = buildVm({
      phase: "booting",
      bootProbeStatuses: ["pending"],
      scenarioProbeStatuses: ["pending"],
    });

    expect(applyProbePhaseHeuristics(vm).phase).toBe("booting");
  });
});

function buildVm(input: {
  phase: "queued" | "launching" | "booting" | "ready";
  bootProbeStatuses: string[];
  scenarioProbeStatuses: string[];
}) {
  const launchSummary: ScenarioLaunchSummary = {
    scenarioVmName: "web",
    hostname: "web",
    probePhaseMap: Object.fromEntries([
      ...input.bootProbeStatuses.map((_, index) => [`boot-${index}`, "boot"] as const),
      ...input.scenarioProbeStatuses.map(
        (_, index) => [`scenario-${index}`, "scenario"] as const,
      ),
    ]),
    probeDescriptors: [
      ...input.bootProbeStatuses.map((_, index) => ({
        id: `boot-${index}`,
        label: `Boot ${index + 1}`,
        kind: "probe",
        phase: "boot" as const,
      })),
      ...input.scenarioProbeStatuses.map((_, index) => ({
        id: `scenario-${index}`,
        label: `Scenario ${index + 1}`,
        kind: "probe",
        phase: "scenario" as const,
      })),
    ],
  };

  const vm = buildInitialVmState({
    id: "vm-1",
    ordinal: 0,
    scenarioVmId: "scenario-vm-1",
    scenarioVmName: "web",
    runtimeVmName: "web-run",
    hostname: "web",
    launchSummary,
  });

  return decorateVmState({
    ...vm,
    phase: input.phase,
    bootProbes: vm.bootProbes.map((probe, index) => ({
      ...probe,
      status: input.bootProbeStatuses[index] ?? probe.status,
    })),
    scenarioProbes: vm.scenarioProbes.map((probe, index) => ({
      ...probe,
      status: input.scenarioProbeStatuses[index] ?? probe.status,
    })),
  });
}
