import { describe, expect, it } from "vitest";
import type { VmStateV3 } from "@/generated/contracts/bridge-message-v9";
import {
  applyVmStateV3ToRunState,
  deriveVmPhase,
  matchesVmReportIdentity,
} from "@/lib/run-lifecycle";
import {
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";

describe("run lifecycle", () => {
  it("removes retired benchmark evidence from legacy run documents", () => {
    const current = initialRunState();
    const legacyVm = {
      ...current.vms[0]!,
      bootEvidence: { generation: "retired" },
      workerDesiredDispatchAt: 1,
      workerDesiredDispatchVersion: 2,
      workerTerminalReportReceivedAt: 3,
      workerTerminalProjectionAckAt: 4,
      workerTerminalReceiptToProjectionAckMs: 5,
      workerTerminalProjectionGeneration: "retired",
      workerTerminalDesiredVersion: 6,
    };

    const [vm] = recomputeRunState({ ...current, vms: [legacyVm] }).vms;
    expect(vm).not.toHaveProperty("bootEvidence");
    expect(vm).not.toHaveProperty("workerDesiredDispatchAt");
    expect(vm).not.toHaveProperty("workerDesiredDispatchVersion");
    expect(vm).not.toHaveProperty("workerTerminalReportReceivedAt");
    expect(vm).not.toHaveProperty("workerTerminalProjectionAckAt");
    expect(vm).not.toHaveProperty("workerTerminalReceiptToProjectionAckMs");
    expect(vm).not.toHaveProperty("workerTerminalProjectionGeneration");
    expect(vm).not.toHaveProperty("workerTerminalDesiredVersion");
  });

  it("requires run id and vm name to match report identity", () => {
    expect(
      matchesVmReportIdentity({
        runId: "run-a",
        runtimeVmName: "webserver",
        reportRunId: "run-a",
        reportVmName: "webserver",
      }),
    ).toBe(true);

    expect(
      matchesVmReportIdentity({
        runId: "run-a",
        runtimeVmName: "webserver",
        reportRunId: "run-b",
        reportVmName: "webserver",
      }),
    ).toBe(false);

    expect(
      matchesVmReportIdentity({
        runId: "run-a",
        runtimeVmName: "webserver",
        reportRunId: "run-a",
        reportVmName: "database",
      }),
    ).toBe(false);
  });

  it("ignores reports with a matching vm name from a different run", () => {
    const current = initialRunState();
    const next = applyVmReportToRunState({
      runId: "run-a",
      current,
      report: vmReport({
        runId: "run-b",
        vmName: "webserver",
        phase: "failed",
        error: "wrong run",
      }),
    });

    expect(next.vms[0]?.phase).toBe("queued");
    expect(next.phase).toBe("queued");
  });

  it("copies reported network and ssh host key into the terminal target", () => {
    const current = initialRunState();
    const next = applyVmReportToRunState({
      runId: "run-a",
      current,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        network: {
          bridge_name: "intar-run-a",
          guest_ip: "10.77.0.2",
          guest_cidr: "10.77.0.2/28",
          gateway: "10.77.0.1",
          ssh_host: "203.0.113.7",
          ssh_host_port: 2201,
        },
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIhostkey"],
        ...readyTerminalEvidence({
          host: "203.0.113.7",
          port: 2201,
          observedAt: 1_762_041_660_000,
        }),
      }),
    });

    // The terminal target must be routable from stargate: advertised host +
    // forward port; the guest IP is tracked separately.
    expect(next.vms[0]?.terminalTarget).toMatchObject({
      host: "203.0.113.7",
      port: 2201,
      username: "user",
      hostKeyOpenssh: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIhostkey",
    });
    expect(next.vms[0]?.guestIp).toBe("10.77.0.2");
    expect(next.vms[0]?.terminalPhase).toBe("ready");
  });

  it("ignores older reports after a newer vm report was accepted", () => {
    const current = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        observedAt: 2_000,
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAhostkey"],
        resourceState: vmResourceState(),
        ...readyTerminalEvidence({
          host: "203.0.113.7",
          port: 2201,
          observedAt: 2_000,
        }),
      }),
    });
    expect(current.vms[0]?.resourceState?.cpu_millis).toBe(1_000);
    const stale = applyVmReportToRunState({
      runId: "run-a",
      current,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "failed",
        error: "old failure",
        observedAt: 1_999,
      }),
    });

    expect(stale.vms[0]?.phase).toBe("ready");
    expect(stale.vms[0]?.runtimeObservedAt).toBe(2_000);
    expect(stale.vms[0]?.terminalPhase).toBe("ready");
    expect(stale.vms[0]?.canOpenTerminal).toBe(true);
    expect(stale.phase).toBe("active_full");
  });

  it("revokes sticky terminal evidence when a new jail generation boots", () => {
    const ready = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        observedAt: 2_000,
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAhostkey"],
        resourceState: vmResourceState(),
        ...readyTerminalEvidence({
          host: "203.0.113.7",
          port: 2201,
          observedAt: 2_000,
          generation: "generation-1",
        }),
      }),
    });

    const rebooting = applyVmReportToRunState({
      runId: "run-a",
      current: ready,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "booting",
        observedAt: 2_001,
        runtimeConstraints: {
          generation: "generation-2",
          cpu_millis: 1_000,
        },
      }),
    });

    expect(rebooting.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalTarget: { host: null, hostKeyOpenssh: null },
      runtimeConstraints: {
        generation: "generation-2",
        cpuMillis: 1_000,
        quotaVerifiedAt: null,
      },
      resourceState: null,
      retiredRuntimeGenerations: ["generation-1"],
    });
    expect(rebooting.vms[0]?.bootProbes[0]?.status).toBe("pending");

    const staleFirstGeneration = applyVmReportToRunState({
      runId: "run-a",
      current: rebooting,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        observedAt: 2_002,
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAstalehostkey"],
        ...readyTerminalEvidence({
          host: "203.0.113.8",
          port: 2202,
          observedAt: 2_002,
          generation: "generation-1",
        }),
      }),
    });

    expect(staleFirstGeneration).toEqual(rebooting);

    const generationlessFailure = applyVmReportToRunState({
      runId: "run-a",
      current: rebooting,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "failed",
        observedAt: 2_003,
        error: "legacy report raced the generation-aware projection",
      }),
    });

    expect(generationlessFailure).toEqual(rebooting);
  });

  it("never retains an endpoint for pending or failed terminal state", () => {
    const pendingWithLegacyEndpoint = initialRunState();
    const pendingVm = pendingWithLegacyEndpoint.vms[0];
    if (!pendingVm) {
      throw new Error("expected initial vm");
    }
    pendingVm.terminalTarget = {
      host: "203.0.113.7",
      port: 2201,
      username: "user",
      hostKeyOpenssh: "ssh-ed25519 AAAAlegacyhostkey",
      checkedAt: 1_999,
    };

    const pending = applyVmReportToRunState({
      runId: "run-a",
      current: pendingWithLegacyEndpoint,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "running",
        observedAt: 2_000,
      }),
    });

    expect(pending.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalTarget: {
        host: null,
        port: 22,
        hostKeyOpenssh: null,
        checkedAt: null,
      },
    });
    expect(pending).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalTarget: { host: null, port: 22 },
    });

    const ready = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        observedAt: 2_000,
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAhostkey"],
        ...readyTerminalEvidence({
          host: "203.0.113.7",
          port: 2201,
          observedAt: 2_000,
          generation: "generation-1",
        }),
      }),
    });
    const stillReady = applyVmReportToRunState({
      runId: "run-a",
      current: ready,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "running",
        observedAt: 2_001,
        terminal: {
          state: "pending",
          reason: "A periodic TCP probe is retrying.",
          observed_at_unix_ms: 2_001,
        },
        runtimeConstraints: {
          generation: "generation-1",
          cpu_millis: 1_000,
          quota_verified_at_unix_ms: 1_999,
        },
      }),
    });

    // A same-generation pending observation cannot create a pending state
    // carrying an endpoint. Once readiness is attested it remains ready until
    // an explicit failure or a new generation revokes it.
    expect(stillReady.vms[0]).toMatchObject({
      terminalPhase: "ready",
      canOpenTerminal: true,
      terminalTarget: { host: "203.0.113.7", port: 2201 },
    });
    expect(stillReady).toMatchObject({
      phase: "active_full",
      phaseDetail: "All required VMs are ready.",
    });

    const failed = applyVmReportToRunState({
      runId: "run-a",
      current: stillReady,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "failed",
        observedAt: 2_002,
        terminal: {
          state: "failed",
          reason: "SSH host-key verification failed.",
          observed_at_unix_ms: 2_002,
        },
        runtimeConstraints: {
          generation: "generation-1",
          cpu_millis: 1_000,
          quota_verified_at_unix_ms: 1_999,
        },
      }),
    });

    expect(failed.vms[0]).toMatchObject({
      terminalPhase: "failed",
      canOpenTerminal: false,
      terminalTarget: {
        host: null,
        port: 22,
        hostKeyOpenssh: null,
        checkedAt: null,
      },
    });
    expect(failed).toMatchObject({
      phase: "failed",
      phaseDetail: "SSH host-key verification failed.",
      terminalPhase: "failed",
      canOpenTerminal: false,
      terminalTarget: { host: null, port: 22 },
    });
  });

  it("does not infer terminal readiness from a reserved network endpoint", () => {
    const next = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        network: {
          bridge_name: "intar-run-a",
          guest_ip: "10.77.0.2",
          guest_cidr: "10.77.0.2/28",
          gateway: "10.77.0.1",
          ssh_host: "203.0.113.7",
          ssh_host_port: 2201,
        },
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAhostkey"],
      }),
    });

    expect(next.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalTarget: { host: null, port: 22 },
    });
  });

  it("requires exact verified steady CPU evidence before accepting ready", () => {
    const unsealed = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAhostkey"],
        terminal: readyTerminalEvidence({
          host: "203.0.113.7",
          port: 2201,
          observedAt: 2_000,
        }).terminal,
        runtimeConstraints: {
          generation: "generation-1",
          cpu_millis: 1_000,
        },
      }),
    });
    expect(unsealed.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalReason: "Waiting for CPU limit verification.",
    });

    const wrongQuota = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        sshHostKeysOpenssh: ["ssh-ed25519 AAAAhostkey"],
        terminal: readyTerminalEvidence({
          host: "203.0.113.7",
          port: 2201,
          observedAt: 2_000,
        }).terminal,
        runtimeConstraints: {
          generation: "generation-1",
          cpu_millis: 2_000,
          quota_verified_at_unix_ms: 1_999,
        },
      }),
    });
    expect(wrongQuota.vms[0]?.canOpenTerminal).toBe(false);
  });

  it("keeps duplicate reports idempotent", () => {
    const report = vmReport({
      runId: "run-a",
      vmName: "webserver",
      phase: "ready",
      observedAt: 2_000,
    });
    const current = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report,
    });
    const duplicate = applyVmReportToRunState({
      runId: "run-a",
      current,
      report,
    });

    expect(duplicate).toEqual(current);
  });

  it("rejects phase regression attempts from later reports", () => {
    const ready = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        observedAt: 2_000,
      }),
    });
    const regressed = applyVmReportToRunState({
      runId: "run-a",
      current: ready,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "booting",
        observedAt: 2_001,
      }),
    });

    expect(regressed.vms[0]?.phase).toBe("ready");
    expect(regressed.vms[0]?.runtimeObservedAt).toBe(2_001);
  });

  it("ignores reports for unknown vm names", () => {
    const current = initialRunState();
    const next = applyVmReportToRunState({
      runId: "run-a",
      current,
      report: vmReport({
        runId: "run-a",
        vmName: "database",
        phase: "ready",
      }),
    });

    expect(next).toEqual(current);
  });

  it("derives solved from scenario probes even when the report phase is only running", () => {
    const baseVm = initialRunState().vms[0];
    if (!baseVm) {
      throw new Error("expected initial vm");
    }
    const vm: RunVmStateDocument = {
      ...baseVm,
      bootProbes: [
        {
          id: "boot-ssh",
          label: "SSH",
          kind: "probe",
          phase: "boot",
          status: "pass",
          error: null,
          value: null,
        },
      ],
      scenarioProbes: [
        {
          id: "nginx-running",
          label: "Nginx",
          kind: "probe",
          phase: "scenario",
          status: "pass",
          error: null,
          value: null,
        },
      ],
    };

    expect(deriveVmPhase({ vm, reportPhase: "running" })).toEqual({
      phase: "solved",
      phaseDetail: "All scenario probes are passing.",
    });
  });
});

function initialRunState(): RunStateDocument {
  const state = buildInitialRunState({
    vms: [
      {
        id: "vm-row-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-web",
        scenarioVmName: "webserver",
        runtimeVmName: "webserver-run-a",
        hostname: "webserver",
        launchSummary: {
          scenarioVmName: "webserver",
          hostname: "webserver",
          probePhaseMap: {
            "boot-ssh": "boot",
            "nginx-running": "scenario",
          },
          probeDescriptors: [
            {
              id: "boot-ssh",
              label: "SSH",
              kind: "probe",
              phase: "boot",
            },
            {
              id: "nginx-running",
              label: "Nginx",
              kind: "probe",
              phase: "scenario",
            },
          ],
        },
      },
    ],
  });
  const vm = state.vms[0];
  if (vm) {
    vm.provisioning.resources = {
      cpuMillis: 1_000,
      memoryMib: 512,
      diskMib: 4_096,
    };
  }
  return state;
}

/** Applies one bridge 9 VM state whose guest lab is ready. */
function applyVmReportToRunState(input: {
  runId: string;
  current: RunStateDocument;
  report: VmStateV3;
}): RunStateDocument {
  return applyVmStateV3ToRunState({ runId: input.runId, current: input.current, vm: input.report });
}

function vmReport(input: {
  runId: string;
  vmName: string;
  phase: VmStateV3["phase"];
  network?: VmStateV3["network"];
  terminal?: VmStateV3["terminal"];
  runtimeConstraints?: VmStateV3["runtime_constraints"];
  resourceState?: VmStateV3["resource_state"];
  sshHostKeysOpenssh?: string[];
  error?: string | null;
  observedAt?: number;
}): VmStateV3 {
  return {
    owner_user_id: "user-1",
    runtime_execution_id: input.runId,
    generation: 1,
    run_id: input.runId,
    name: input.vmName,
    desired_version: 42,
    phase: input.phase,
    network: input.network ?? null,
    terminal: input.terminal ?? {
      state: input.phase === "failed" ? "failed" : "pending",
      reason:
        input.phase === "failed"
          ? (input.error ?? "vm failed")
          : "terminal readiness pending",
      observed_at_unix_ms: input.observedAt ?? 1_762_041_660_000,
    },
    runtime_constraints: input.runtimeConstraints ?? null,
    resource_state: input.resourceState ?? null,
    sandbox: null,
    ssh_host_keys_openssh: input.sshHostKeysOpenssh ?? [],
    archive: null,
    error: input.error ?? null,
    lab: { state: "ready", kino_version: "test", ready: [], tasks: [], timings_ms: {} },
    updated_at_unix_ms: input.observedAt ?? 1_762_041_660_000,
  };
}

function readyTerminalEvidence(input: {
  host: string;
  port: number;
  observedAt: number;
  generation?: string;
}): {
  terminal: NonNullable<VmStateV3["terminal"]>;
  runtimeConstraints: NonNullable<VmStateV3["runtime_constraints"]>;
} {
  return {
    terminal: {
      state: "ready",
      target: {
        host: input.host,
        port: input.port,
        username: "user",
        checked_at_unix_ms: input.observedAt,
      },
      observed_at_unix_ms: input.observedAt,
    },
    runtimeConstraints: {
      generation: input.generation ?? "generation-1",
      cpu_millis: 1_000,
      quota_verified_at_unix_ms: input.observedAt - 1,
    },
  };
}

function vmResourceState(): NonNullable<VmStateV3["resource_state"]> {
  return {
    cpu_millis: 1_000,
    cpu_quota_us: 100_000,
    cpu_period_us: 100_000,
    cpu_usage_usec: 1,
    cpu_user_usec: 1,
    cpu_system_usec: 0,
    cpu_nr_periods: 1,
    cpu_nr_throttled: 0,
    cpu_throttled_usec: 0,
  };
}
