import { describe, expect, it } from "vitest";
import type { HostStateReportV2, VmReportV2 } from "@/generated/bridge";
import {
  applyHostReportToRunState,
  applyVmReportToRunState,
  deriveVmPhase,
  matchesInventoryVmIdentity,
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

  it("matches inventory by run id and vm name when a run id is present", () => {
    expect(
      matchesInventoryVmIdentity({
        value: {
          run_id: "run-a",
          vm_name: "webserver",
        },
        runId: "run-a",
        runtimeVmName: "webserver",
      }),
    ).toBe(true);

    expect(
      matchesInventoryVmIdentity({
        value: {
          run_id: "run-b",
          vm_name: "webserver",
        },
        runId: "run-a",
        runtimeVmName: "webserver",
      }),
    ).toBe(false);

    expect(
      matchesInventoryVmIdentity({
        value: {
          run_id: "run-a",
          vm_name: "database",
        },
        runId: "run-a",
        runtimeVmName: "webserver",
      }),
    ).toBe(false);
  });

  it("rejects inventory snapshots without run identity", () => {
    expect(
      matchesInventoryVmIdentity({
        value: {
          name: "webserver",
        },
        runId: "run-a",
        runtimeVmName: "webserver",
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

  it("promotes a matching vm report with passing scenario probes to solved", () => {
    const current = initialRunState();
    const next = applyVmReportToRunState({
      runId: "run-a",
      current,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "running",
        probes: [
          {
            id: "boot-ssh",
            phase: "boot",
            status: "pass",
            checked_at_unix_ms: 1_762_041_660_000,
          },
          {
            id: "nginx-running",
            phase: "scenario",
            status: "pass",
            checked_at_unix_ms: 1_762_041_660_000,
          },
        ],
      }),
    });

    expect(next.vms[0]?.phase).toBe("solved");
    expect(next.phase).toBe("solved");
    expect(next.vms[0]?.scenarioProbes[0]?.status).toBe("pass");
  });

  it("keeps a probe message as ordinary repair-result detail", () => {
    const mismatch = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "running",
        observedAt: 1_000,
        probes: [
          {
            id: "nginx-running",
            phase: "scenario",
            status: "fail",
            message: "connection refused",
            checked_at_unix_ms: 1_000,
          },
        ],
      }),
    });
    expect(mismatch.vms[0]?.scenarioProbes[0]).toMatchObject({
      status: "fail",
      error: "connection refused",
    });
    expect(mismatch.vms[0]).not.toHaveProperty("verificationCollectionError");
  });

  it("applies host reports to only the matching run vm", () => {
    const current = initialRunState();
    const next = applyHostReportToRunState({
      runId: "run-a",
      current,
      report: hostReport([
        {
          run_id: "run-b",
          vm_name: "webserver",
          phase: "failed",
          terminal: {
            state: "failed",
            reason: "other run failed",
            observed_at_unix_ms: 1_762_041_660_000,
          },
          ssh_host_keys_openssh: [],
          probes: [],
          error: "other run failed",
          updated_at_unix_ms: 1_762_041_660_000,
        },
        {
          run_id: "run-a",
          vm_name: "webserver",
          phase: "ready",
          terminal: {
            state: "pending",
            reason: "terminal readiness pending",
            observed_at_unix_ms: 1_762_041_660_000,
          },
          ssh_host_keys_openssh: [],
          probes: [
            {
              id: "boot-ssh",
              phase: "boot",
              status: "pass",
              checked_at_unix_ms: 1_762_041_660_000,
            },
          ],
          updated_at_unix_ms: 1_762_041_660_000,
        },
      ]),
    });

    expect(next.vms[0]?.phase).toBe("ready");
    expect(next.vms[0]?.phaseDetail).toBe(
      "Boot probes passed. Waiting for shell target.",
    );
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
      username: "ubuntu",
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
          phase: "boot_burst",
          steady_cpu_millis: 1_000,
          effective_cpu_millis: 2_000,
          lease_expires_at_unix_ms: 47_001,
        },
      }),
    });

    expect(rebooting.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalTarget: { host: null, hostKeyOpenssh: null },
      runtimeConstraints: {
        generation: "generation-2",
        phase: "boot_burst",
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
      username: "ubuntu",
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
          phase: "steady",
          steady_cpu_millis: 1_000,
          effective_cpu_millis: 1_000,
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
          phase: "steady",
          steady_cpu_millis: 1_000,
          effective_cpu_millis: 1_000,
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
          phase: "boot_burst",
          steady_cpu_millis: 1_000,
          effective_cpu_millis: 2_000,
          lease_expires_at_unix_ms: 47_000,
        },
      }),
    });
    expect(unsealed.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalReason: "Waiting for verified steady CPU quota.",
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
          phase: "steady",
          steady_cpu_millis: 1_000,
          effective_cpu_millis: 2_000,
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
    const solved = applyVmReportToRunState({
      runId: "run-a",
      current: initialRunState(),
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "solved",
        observedAt: 2_000,
      }),
    });
    const regressed = applyVmReportToRunState({
      runId: "run-a",
      current: solved,
      report: vmReport({
        runId: "run-a",
        vmName: "webserver",
        phase: "ready",
        observedAt: 2_001,
      }),
    });

    expect(regressed.vms[0]?.phase).toBe("solved");
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
        runtimeVmName: "webserver",
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
      vcpuCount: 1,
      memoryMib: 512,
      diskMib: 4_096,
    };
  }
  return state;
}

function vmReport(input: {
  runId: string;
  vmName: string;
  phase: VmReportV2["phase"];
  network?: VmReportV2["network"];
  terminal?: VmReportV2["terminal"];
  runtimeConstraints?: VmReportV2["runtime_constraints"];
  resourceState?: VmReportV2["resource_state"];
  sshHostKeysOpenssh?: string[];
  probes?: VmReportV2["probes"];
  error?: string | null;
  observedAt?: number;
}): VmReportV2 {
  return {
    schema_version: 3,
    host_id: "host-alpha",
    run_id: input.runId,
    vm_name: input.vmName,
    desired_version: 42,
    observed_at_unix_ms: input.observedAt ?? 1_762_041_660_000,
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
    probes: input.probes ?? [],
    archive: null,
    error: input.error ?? null,
  };
}

function readyTerminalEvidence(input: {
  host: string;
  port: number;
  observedAt: number;
  generation?: string;
}): {
  terminal: NonNullable<VmReportV2["terminal"]>;
  runtimeConstraints: NonNullable<VmReportV2["runtime_constraints"]>;
} {
  return {
    terminal: {
      state: "ready",
      target: {
        host: input.host,
        port: input.port,
        username: "ubuntu",
        checked_at_unix_ms: input.observedAt,
      },
      observed_at_unix_ms: input.observedAt,
    },
    runtimeConstraints: {
      generation: input.generation ?? "generation-1",
      phase: "steady",
      steady_cpu_millis: 1_000,
      effective_cpu_millis: 1_000,
      quota_verified_at_unix_ms: input.observedAt - 1,
    },
  };
}

function vmResourceState(): NonNullable<VmReportV2["resource_state"]> {
  return {
    cpu_millis: 1_000,
    vcpu_count: 1,
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

function hostReport(vms: HostStateReportV2["vms"]): HostStateReportV2 {
  return {
    schema_version: 4,
    host_id: "host-alpha",
    observed_at_unix_ms: 1_762_041_660_000,
    applied_desired_version: 42,
    capacity: {
      total_cpu_millis: 8_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: 7_000,
      committed_cpu_millis: 1_000,
      memory_total_mib: 32768,
      memory_available_mib: 24576,
      disk_probe_path: "/var/lib/intar-agent",
      disk_total_mib: 524288,
      disk_available_mib: 400000,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256:
        "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: [],
    vms,
    builds: [],
  };
}
