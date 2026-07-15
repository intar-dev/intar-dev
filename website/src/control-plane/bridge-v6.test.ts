import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  BridgeMessageV6,
  BuildReportV1,
  HostDesiredStateV2,
  HostStateReportV2,
  VmReportV2,
} from "@/generated/bridge";
import {
  parseBridgeMessageV6,
  serializeBridgeMessageV6,
} from "@/control-plane/bridge-v6";

describe("bridge v6 protocol", () => {
  it("parses the generated sync request fixture", () => {
    const fixture = readFixture("sync-request-v6.json");
    expect(parseBridgeMessageV6(JSON.stringify(fixture))).toEqual(fixture);
  });

  it("serializes bridge messages as snake_case v6 JSON", () => {
    const fixture = readFixture<BridgeMessageV6>("sync-request-v6.json");
    expect(JSON.parse(serializeBridgeMessageV6(fixture))).toEqual(fixture);
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "desired_state",
          protocol_version: 6,
          host_id: desiredState.host_id,
          desired_state: desiredState,
        }),
      )?.type,
    ).toBe("desired_state");
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "state_report",
          protocol_version: 6,
          host_id: hostReport.host_id,
          report: hostReport,
        }),
      )?.type,
    ).toBe("state_report");
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: vmReport,
        }),
      )?.type,
    ).toBe("vm_report");
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "build_report",
          protocol_version: 6,
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

    const parsed = parseBridgeMessageV6(
      JSON.stringify({
        type: "state_report",
        protocol_version: 6,
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
      protocol_version: 6,
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
        supports_jailer_v1: false,
        supports_jailer_v2: true,
        supports_boot_cpu_lease: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
      },
    };

    expect(parseBridgeMessageV6(JSON.stringify(clientHello))?.type).toBe(
      "client_hello",
    );
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          ...clientHello,
          capabilities: {
            ...clientHello.capabilities,
            supports_kvm: "yes",
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects non-v6 protocol envelopes", () => {
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "sync_request",
          protocol_version: 4,
          host_id: "host-alpha",
          reason: "reconnect",
        }),
      ),
    ).toBeNull();
  });

  it("rejects desired states missing required v6 arrays", () => {
    const desiredState = readFixture<HostDesiredStateV2>(
      "host-desired-state-v2.json",
    );
    const { builds: _builds, ...missingBuilds } = desiredState;

    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "desired_state",
          protocol_version: 6,
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
    badCachedImage.cached_images[0]!.image_sha256 = "not-a-sha256";
    const badDesiredVm = cloneFixture(desiredState);
    badDesiredVm.vms[0]!.image_sha256 = "not-a-sha256";
    const badBuild = cloneFixture(desiredState);
    badBuild.builds[0]!.content_hash = "not-a-sha256";

    for (const candidate of [badCachedImage, badDesiredVm, badBuild]) {
      expect(
        parseBridgeMessageV6(
          JSON.stringify({
            type: "desired_state",
            protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "desired_state",
          protocol_version: 6,
          host_id: desiredState.host_id,
          desired_state: zeroCpu,
        }),
      ),
    ).toBeNull();

    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    const badQuota = cloneFixture(vmReport);
    badQuota.resource_state!.cpu_quota_us = 0;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: badQuota,
        }),
      ),
    ).toBeNull();

    const badSandbox = cloneFixture(vmReport);
    badSandbox.sandbox!.systemd_unit = "";
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: badSandbox,
        }),
      ),
    ).toBeNull();
  });

  it("rejects report envelopes with a mismatched host id", () => {
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: readyWithoutTarget,
        }),
      ),
    ).toBeNull();

    const pendingWithTarget = cloneFixture(vmReport);
    pendingWithTarget.terminal!.state = "pending";
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: pendingWithTarget,
        }),
      ),
    ).toBeNull();

    const { terminal: _terminal, ...missingTerminal } = vmReport;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: missingTerminal,
        }),
      ),
    ).toBeNull();

    const activeWithoutRuntime = cloneFixture(vmReport);
    activeWithoutRuntime.runtime_constraints = null;
    activeWithoutRuntime.boot_evidence = null;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
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
    pending.boot_evidence = null;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: unverifiedSteady,
        }),
      ),
    ).toBeNull();

    const zeroTimestamp = cloneFixture(vmReport);
    zeroTimestamp.runtime_constraints!.quota_verified_at_unix_ms = 0;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: zeroTimestamp,
        }),
      ),
    ).toBeNull();

    const bootBurst = cloneFixture(vmReport);
    bootBurst.runtime_constraints!.phase = "boot_burst";
    delete bootBurst.runtime_constraints!.quota_verified_at_unix_ms;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: missingProbes,
        }),
      ),
    ).toBeNull();
  });

  it("strictly validates generation-fenced boot phase and CPU evidence", () => {
    const vmReport = readFixture<VmReportV2>("vm-report-v2.json");
    expect(vmReport.boot_evidence).toBeTruthy();

    const staleGeneration = cloneFixture(vmReport);
    staleGeneration.boot_evidence!.generation = "stale-generation";
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: staleGeneration,
        }),
      ),
    ).toBeNull();

    const duplicatePoint = cloneFixture(vmReport);
    duplicatePoint.boot_evidence!.cpu_samples[4]!.point = "post_seal";
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: duplicatePoint,
        }),
      ),
    ).toBeNull();

    const boundedTelemetryMiss = cloneFixture(vmReport);
    boundedTelemetryMiss.boot_evidence!.cpu_samples.pop();
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: boundedTelemetryMiss,
        }),
      )?.type,
    ).toBe("vm_report");

    const burstCredits = cloneFixture(vmReport);
    burstCredits.boot_evidence!.cpu_samples[0]!.cpu_max_burst = 1;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: burstCredits,
        }),
      ),
    ).toBeNull();

    const negativeDuration = cloneFixture(vmReport);
    negativeDuration.boot_evidence!.phases.guest_to_kino_ms = -1;
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "vm_report",
          protocol_version: 6,
          host_id: vmReport.host_id,
          report: negativeDuration,
        }),
      ),
    ).toBeNull();
  });

  it("rejects build reports with unsupported phases", () => {
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");
    expect(
      parseBridgeMessageV6(
        JSON.stringify({
          type: "build_report",
          protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "build_report",
          protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "state_report",
          protocol_version: 6,
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
      parseBridgeMessageV6(
        JSON.stringify({
          type: "state_report",
          protocol_version: 6,
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
