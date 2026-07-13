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
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";

describe("run lifecycle", () => {
  it("requires run id and vm name to match report identity", () => {
    expect(matchesVmReportIdentity({
      runId: "run-a",
      runtimeVmName: "webserver",
      reportRunId: "run-a",
      reportVmName: "webserver",
    })).toBe(true);

    expect(matchesVmReportIdentity({
      runId: "run-a",
      runtimeVmName: "webserver",
      reportRunId: "run-b",
      reportVmName: "webserver",
    })).toBe(false);

    expect(matchesVmReportIdentity({
      runId: "run-a",
      runtimeVmName: "webserver",
      reportRunId: "run-a",
      reportVmName: "database",
    })).toBe(false);
  });

  it("matches inventory by run id and vm name when a run id is present", () => {
    expect(matchesInventoryVmIdentity({
      value: {
        run_id: "run-a",
        vm_name: "webserver",
      },
      runId: "run-a",
      runtimeVmName: "webserver",
    })).toBe(true);

    expect(matchesInventoryVmIdentity({
      value: {
        run_id: "run-b",
        vm_name: "webserver",
      },
      runId: "run-a",
      runtimeVmName: "webserver",
    })).toBe(false);

    expect(matchesInventoryVmIdentity({
      value: {
        run_id: "run-a",
        vm_name: "database",
      },
      runId: "run-a",
      runtimeVmName: "webserver",
    })).toBe(false);
  });

  it("rejects inventory snapshots without run identity", () => {
    expect(matchesInventoryVmIdentity({
      value: {
        name: "webserver",
      },
      runId: "run-a",
      runtimeVmName: "webserver",
    })).toBe(false);
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
          ssh_host_keys_openssh: [],
          probes: [],
          error: "other run failed",
          updated_at_unix_ms: 1_762_041_660_000,
        },
        {
          run_id: "run-a",
          vm_name: "webserver",
          phase: "ready",
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
        sshHostKeysOpenssh: [
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIhostkey",
        ],
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
      }),
    });
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
    expect(stale.phase).toBe("active_full");
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
  return buildInitialRunState({
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
}

function vmReport(input: {
  runId: string;
  vmName: string;
  phase: VmReportV2["phase"];
  network?: VmReportV2["network"];
  sshHostKeysOpenssh?: string[];
  probes?: VmReportV2["probes"];
  error?: string | null;
  observedAt?: number;
}): VmReportV2 {
  return {
    schema_version: 2,
    host_id: "host-alpha",
    run_id: input.runId,
    vm_name: input.vmName,
    desired_version: 42,
    observed_at_unix_ms: input.observedAt ?? 1_762_041_660_000,
    phase: input.phase,
    network: input.network ?? null,
    ssh_host_keys_openssh: input.sshHostKeysOpenssh ?? [],
    probes: input.probes ?? [],
    archive: null,
    error: input.error ?? null,
  };
}

function hostReport(vms: HostStateReportV2["vms"]): HostStateReportV2 {
  return {
    schema_version: 3,
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
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v1: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: [],
    vms,
    builds: [],
  };
}
