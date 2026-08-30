import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  BridgeMessageV7,
  BuildReportV1,
  HostDesiredStateV2,
  HostStateReportV2,
  VmReportV2,
} from "@/generated/bridge";
import {
  parseBridgeMessageV7,
  serializeBridgeMessageV7,
} from "@/control-plane/bridge-v7";

describe("bridge v7 protocol", () => {
  it("parses the generated sync request fixture", () => {
    const fixture = readFixture("sync-request-v7.json");
    expect(parseBridgeMessageV7(JSON.stringify(fixture))).toEqual(fixture);
  });

  it("serializes bridge messages as snake_case v7 JSON", () => {
    const fixture = readFixture<BridgeMessageV7>("sync-request-v7.json");
    expect(JSON.parse(serializeBridgeMessageV7(fixture))).toEqual(fixture);
  });

  it("parses desired state, state report, vm report, and build report envelopes", () => {
    const desiredState = readFixture<HostDesiredStateV2>(
      "host-desired-state-v2.json",
    );
    const hostReport = readFixture<HostStateReportV2>(
      "host-state-report-v2.json",
    );
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");

    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "desired_state",
          protocol_version: 7,
          host_id: desiredState.host_id,
          desired_state: desiredState,
        }),
      )?.type,
    ).toBe("desired_state");
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "state_report",
          protocol_version: 7,
          host_id: hostReport.host_id,
          report: hostReport,
        }),
      )?.type,
    ).toBe("state_report");
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: vmReport,
        }),
      )?.type,
    ).toBe("vm_report");
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "build_report",
          protocol_version: 7,
          host_id: buildReport.host_id,
          report: buildReport,
        }),
      )?.type,
    ).toBe("build_report");
  });

  it("retains unattributed VMs in authoritative host state reports", () => {
    const hostReport = readFixture<HostStateReportV2>(
      "host-state-report-v2.json",
    );
    hostReport.vms[0]!.run_id = "";

    const parsed = parseBridgeMessageV7(
      JSON.stringify({
        type: "state_report",
        protocol_version: 7,
        host_id: hostReport.host_id,
        report: hostReport,
      }),
    );

    expect(parsed?.type).toBe("state_report");
    expect(
      parsed?.type === "state_report" ? parsed.report.vms[0]?.run_id : null,
    ).toBe("");
  });

  it("parses client hello only with valid host capabilities", () => {
    const clientHello = {
      type: "client_hello",
      protocol_version: 7,
      host_id: "host-alpha",
      agent_version: "0.1.0",
      role: "builder",
      last_applied_desired_version: 42,
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
      supports_jailer_v3: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
        supports_boot_cpu_lease: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
      },
    };

    expect(parseBridgeMessageV7(JSON.stringify(clientHello))?.type).toBe(
      "client_hello",
    );
    const legacy = parseBridgeMessageV7(JSON.stringify(clientHello));
    expect(
      legacy?.type === "client_hello"
        ? legacy.capabilities.supports_run_cli_v1
        : null,
    ).toBe(false);
    expect(
      legacy?.type === "client_hello"
        ? legacy.capabilities.supports_run_cli_completion_v1
        : null,
    ).toBe(false);
    const capable = parseBridgeMessageV7(
      JSON.stringify({
        ...clientHello,
        capabilities: {
          ...clientHello.capabilities,
          supports_run_cli_v1: true,
          supports_run_cli_completion_v1: true,
        },
      }),
    );
    expect(capable?.type).toBe("client_hello");
    expect(
      capable?.type === "client_hello"
        ? capable.capabilities.supports_run_cli_v1
        : null,
    ).toBe(true);
    expect(
      capable?.type === "client_hello"
        ? capable.capabilities.supports_run_cli_completion_v1
        : null,
    ).toBe(true);
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          ...clientHello,
          capabilities: {
            ...clientHello.capabilities,
            supports_kvm: "yes",
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          ...clientHello,
          capabilities: {
            ...clientHello.capabilities,
            supports_run_cli_v1: "yes",
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          ...clientHello,
          capabilities: {
            ...clientHello.capabilities,
            supports_run_cli_completion_v1: "yes",
          },
        }),
      ),
    ).toBeNull();
  });

  it("defaults an old host state report to no run-CLI support", () => {
    const report = readFixture<HostStateReportV2>(
      "host-state-report-v2.json",
    );
    delete report.capabilities.supports_run_cli_v1;
    delete report.capabilities.supports_run_cli_completion_v1;
    const parsed = parseBridgeMessageV7(
      JSON.stringify({
        type: "state_report",
        protocol_version: 7,
        host_id: report.host_id,
        report,
      }),
    );
    expect(
      parsed?.type === "state_report"
        ? parsed.report.capabilities.supports_run_cli_v1
        : null,
    ).toBe(false);
    expect(
      parsed?.type === "state_report"
        ? parsed.report.capabilities.supports_run_cli_completion_v1
        : null,
    ).toBe(false);
  });

  it("rejects non-v7 protocol envelopes", () => {
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "sync_request",
          protocol_version: 4,
          host_id: "host-alpha",
          reason: "reconnect",
        }),
      ),
    ).toBeNull();
  });

  it("rejects desired states missing required v7 arrays", () => {
    const desiredState = readFixture<HostDesiredStateV2>(
      "host-desired-state-v2.json",
    );
    const { builds: _builds, ...missingBuilds } = desiredState;

    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "desired_state",
          protocol_version: 7,
          host_id: desiredState.host_id,
          desired_state: missingBuilds,
        }),
      ),
    ).toBeNull();
  });

  it("rejects desired states with malformed hashes", () => {
    const desiredState = readFixture<HostDesiredStateV2>(
      "host-desired-state-v2.json",
    );
    const badCachedImage = cloneFixture(desiredState);
    badCachedImage.cached_images[0]!.image_id = "not-a-sha256";
    const badDesiredVm = cloneFixture(desiredState);
    badDesiredVm.vms[0]!.image_id = "not-a-sha256";
    const badBuild = cloneFixture(desiredState);
    badBuild.builds[0]!.content_hash = "not-a-sha256";

    for (const candidate of [badCachedImage, badDesiredVm, badBuild]) {
      expect(
        parseBridgeMessageV7(
          JSON.stringify({
            type: "desired_state",
            protocol_version: 7,
            host_id: desiredState.host_id,
            desired_state: candidate,
          }),
        ),
      ).toBeNull();
    }
  });

  it("rejects zero CPU entitlements and malformed sandbox accounting", () => {
    const desiredState = readFixture<HostDesiredStateV2>(
      "host-desired-state-v2.json",
    );
    const zeroCpu = cloneFixture(desiredState);
    zeroCpu.vms[0]!.resources.cpu_millis = 0;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "desired_state",
          protocol_version: 7,
          host_id: desiredState.host_id,
          desired_state: zeroCpu,
        }),
      ),
    ).toBeNull();

    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    const badQuota = cloneFixture(vmReport);
    badQuota.resource_state!.cpu_quota_us = 0;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: badQuota,
        }),
      ),
    ).toBeNull();

    const badSandbox = cloneFixture(vmReport);
    badSandbox.sandbox!.systemd_unit = "";
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: badSandbox,
        }),
      ),
    ).toBeNull();
  });

  it("rejects report envelopes with a mismatched host id", () => {
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: "host-bravo",
          report: vmReport,
        }),
      ),
    ).toBeNull();
  });

  it("requires an explicit terminal target only for ready reports", () => {
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    const readyWithoutTarget = cloneFixture(vmReport);
    delete readyWithoutTarget.terminal!.target;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: readyWithoutTarget,
        }),
      ),
    ).toBeNull();

    const pendingWithTarget = cloneFixture(vmReport);
    pendingWithTarget.terminal!.state = "pending";
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: pendingWithTarget,
        }),
      ),
    ).toBeNull();

    const { terminal: _terminal, ...missingTerminal } = vmReport;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: missingTerminal,
        }),
      ),
    ).toBeNull();

    const activeWithoutRuntime = cloneFixture(vmReport);
    activeWithoutRuntime.runtime_constraints = null;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: activeWithoutRuntime,
        }),
      ),
    ).toBeNull();

    const pending = cloneFixture(vmReport);
    pending.phase = "pending";
    pending.terminal = {
      state: "pending",
      reason: "waiting for launch",
      observed_at_unix_ms: vmReport.observed_at_unix_ms,
    };
    pending.runtime_constraints = null;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: pending,
        }),
      )?.type,
    ).toBe("vm_report");
  });

  it("requires live quota verification for a steady runtime", () => {
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    const unverifiedSteady = cloneFixture(vmReport);
    delete unverifiedSteady.runtime_constraints!.quota_verified_at_unix_ms;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: unverifiedSteady,
        }),
      ),
    ).toBeNull();

    const zeroTimestamp = cloneFixture(vmReport);
    zeroTimestamp.runtime_constraints!.quota_verified_at_unix_ms = 0;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: zeroTimestamp,
        }),
      ),
    ).toBeNull();

    const bootBurst = cloneFixture(vmReport);
    bootBurst.runtime_constraints!.phase = "boot_burst";
    delete bootBurst.runtime_constraints!.quota_verified_at_unix_ms;
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: bootBurst,
        }),
      )?.type,
    ).toBe("vm_report");
  });

  it("rejects vm reports missing required report arrays", () => {
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    const { probes: _probes, ...missingProbes } = vmReport;

    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 7,
          host_id: vmReport.host_id,
          report: missingProbes,
        }),
      ),
    ).toBeNull();
  });

  it("rejects build reports with unsupported phases", () => {
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "build_report",
          protocol_version: 7,
          host_id: buildReport.host_id,
          report: {
            ...buildReport,
            phase: "stale",
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects build reports with malformed content hashes", () => {
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "build_report",
          protocol_version: 7,
          host_id: buildReport.host_id,
          report: {
            ...buildReport,
            content_hash: "not-a-sha256",
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects state reports missing required report arrays", () => {
    const hostReport = readFixture<HostStateReportV2>(
      "host-state-report-v2.json",
    );
    const { vms: _vms, ...missingVms } = hostReport;

    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "state_report",
          protocol_version: 7,
          host_id: hostReport.host_id,
          report: missingVms,
        }),
      ),
    ).toBeNull();
  });

  it("rejects state reports with malformed embedded build reports", () => {
    const hostReport = readFixture<HostStateReportV2>(
      "host-state-report-v2.json",
    );
    expect(
      parseBridgeMessageV7(
        JSON.stringify({
          type: "state_report",
          protocol_version: 7,
          host_id: hostReport.host_id,
          report: {
            ...hostReport,
            builds: [
              {
                ...hostReport.builds[0],
                attempt: -1,
              },
            ],
          },
        }),
      ),
    ).toBeNull();
  });
});

function readFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../generated/fixtures/bridge/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;
}

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
