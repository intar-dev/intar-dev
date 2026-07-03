import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  BridgeMessageV5,
  BuildReportV1,
  HostDesiredStateV1,
  HostStateReportV1,
  VmReportV1,
} from "@/generated/bridge";
import {
  parseBridgeMessageV5,
  serializeBridgeMessageV5,
} from "@/control-plane/bridge-v5";

describe("bridge v5 protocol", () => {
  it("parses the generated sync request fixture", () => {
    const fixture = readFixture("sync-request-v5.json");
    expect(parseBridgeMessageV5(JSON.stringify(fixture))).toEqual(fixture);
  });

  it("serializes bridge messages as snake_case v5 JSON", () => {
    const fixture = readFixture<BridgeMessageV5>("sync-request-v5.json");
    expect(JSON.parse(serializeBridgeMessageV5(fixture))).toEqual(fixture);
  });

  it("parses desired state, state report, vm report, and build report envelopes", () => {
    const desiredState = readFixture<HostDesiredStateV1>(
      "host-desired-state-v1.json",
    );
    const hostReport = readFixture<HostStateReportV1>(
      "host-state-report-v1.json",
    );
    const vmReport = readFixture<VmReportV1>("vm-report-v1.json");
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");

    expect(parseBridgeMessageV5(JSON.stringify({
      type: "desired_state",
      protocol_version: 5,
      host_id: desiredState.host_id,
      desired_state: desiredState,
    }))?.type).toBe("desired_state");
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "state_report",
      protocol_version: 5,
      host_id: hostReport.host_id,
      report: hostReport,
    }))?.type).toBe("state_report");
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "vm_report",
      protocol_version: 5,
      host_id: vmReport.host_id,
      report: vmReport,
    }))?.type).toBe("vm_report");
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "build_report",
      protocol_version: 5,
      host_id: buildReport.host_id,
      report: buildReport,
    }))?.type).toBe("build_report");
  });

  it("parses client hello only with valid host capabilities", () => {
    const clientHello = {
      type: "client_hello",
      protocol_version: 5,
      host_id: "host-alpha",
      agent_version: "0.1.0",
      role: "builder",
      last_applied_desired_version: 42,
      capabilities: {
        arch: "x86_64",
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
      },
    };

    expect(parseBridgeMessageV5(JSON.stringify(clientHello))?.type).toBe(
      "client_hello",
    );
    expect(parseBridgeMessageV5(JSON.stringify({
      ...clientHello,
      capabilities: {
        ...clientHello.capabilities,
        supports_kvm: "yes",
      },
    }))).toBeNull();
  });

  it("rejects non-v5 protocol envelopes", () => {
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "sync_request",
      protocol_version: 4,
      host_id: "host-alpha",
      reason: "reconnect",
    }))).toBeNull();
  });

  it("rejects desired states missing required v5 arrays", () => {
    const desiredState = readFixture<HostDesiredStateV1>(
      "host-desired-state-v1.json",
    );
    const { builds: _builds, ...missingBuilds } = desiredState;

    expect(parseBridgeMessageV5(JSON.stringify({
      type: "desired_state",
      protocol_version: 5,
      host_id: desiredState.host_id,
      desired_state: missingBuilds,
    }))).toBeNull();
  });

  it("rejects desired states with malformed hashes", () => {
    const desiredState = readFixture<HostDesiredStateV1>(
      "host-desired-state-v1.json",
    );
    const badCachedImage = cloneFixture(desiredState);
    badCachedImage.cached_images[0]!.image_sha256 = "not-a-sha256";
    const badDesiredVm = cloneFixture(desiredState);
    badDesiredVm.vms[0]!.image_sha256 = "not-a-sha256";
    const badBuild = cloneFixture(desiredState);
    badBuild.builds[0]!.content_hash = "not-a-sha256";

    for (const candidate of [badCachedImage, badDesiredVm, badBuild]) {
      expect(parseBridgeMessageV5(JSON.stringify({
        type: "desired_state",
        protocol_version: 5,
        host_id: desiredState.host_id,
        desired_state: candidate,
      }))).toBeNull();
    }
  });

  it("rejects report envelopes with a mismatched host id", () => {
    const vmReport = readFixture<VmReportV1>("vm-report-v1.json");
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "vm_report",
      protocol_version: 5,
      host_id: "host-bravo",
      report: vmReport,
    }))).toBeNull();
  });

  it("rejects vm reports missing required report arrays", () => {
    const vmReport = readFixture<VmReportV1>("vm-report-v1.json");
    const { probes: _probes, ...missingProbes } = vmReport;

    expect(parseBridgeMessageV5(JSON.stringify({
      type: "vm_report",
      protocol_version: 5,
      host_id: vmReport.host_id,
      report: missingProbes,
    }))).toBeNull();
  });

  it("rejects build reports with unsupported phases", () => {
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "build_report",
      protocol_version: 5,
      host_id: buildReport.host_id,
      report: {
        ...buildReport,
        phase: "stale",
      },
    }))).toBeNull();
  });

  it("rejects build reports with malformed content hashes", () => {
    const buildReport = readFixture<BuildReportV1>("build-report-v1.json");
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "build_report",
      protocol_version: 5,
      host_id: buildReport.host_id,
      report: {
        ...buildReport,
        content_hash: "not-a-sha256",
      },
    }))).toBeNull();
  });

  it("rejects state reports missing required report arrays", () => {
    const hostReport = readFixture<HostStateReportV1>(
      "host-state-report-v1.json",
    );
    const { vms: _vms, ...missingVms } = hostReport;

    expect(parseBridgeMessageV5(JSON.stringify({
      type: "state_report",
      protocol_version: 5,
      host_id: hostReport.host_id,
      report: missingVms,
    }))).toBeNull();
  });

  it("rejects state reports with malformed embedded build reports", () => {
    const hostReport = readFixture<HostStateReportV1>(
      "host-state-report-v1.json",
    );
    expect(parseBridgeMessageV5(JSON.stringify({
      type: "state_report",
      protocol_version: 5,
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
    }))).toBeNull();
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
