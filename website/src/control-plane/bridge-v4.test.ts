import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  BridgeMessageV4,
  HostDesiredStateV1,
  HostStateReportV1,
  VmReportV1,
} from "@/generated/bridge";
import {
  parseBridgeMessageV4,
  serializeBridgeMessageV4,
} from "@/control-plane/bridge-v4";

describe("bridge v4 protocol", () => {
  it("parses the generated sync request fixture", () => {
    const fixture = readFixture("sync-request-v4.json");
    expect(parseBridgeMessageV4(JSON.stringify(fixture))).toEqual(fixture);
  });

  it("serializes bridge messages as snake_case v4 JSON", () => {
    const fixture = readFixture<BridgeMessageV4>("sync-request-v4.json");
    expect(JSON.parse(serializeBridgeMessageV4(fixture))).toEqual(fixture);
  });

  it("parses desired state, state report, and vm report envelopes", () => {
    const desiredState = readFixture<HostDesiredStateV1>(
      "host-desired-state-v1.json",
    );
    const hostReport = readFixture<HostStateReportV1>(
      "host-state-report-v1.json",
    );
    const vmReport = readFixture<VmReportV1>("vm-report-v1.json");

    expect(parseBridgeMessageV4(JSON.stringify({
      type: "desired_state",
      protocol_version: 4,
      host_id: desiredState.host_id,
      desired_state: desiredState,
    }))?.type).toBe("desired_state");
    expect(parseBridgeMessageV4(JSON.stringify({
      type: "state_report",
      protocol_version: 4,
      host_id: hostReport.host_id,
      report: hostReport,
    }))?.type).toBe("state_report");
    expect(parseBridgeMessageV4(JSON.stringify({
      type: "vm_report",
      protocol_version: 4,
      host_id: vmReport.host_id,
      report: vmReport,
    }))?.type).toBe("vm_report");
  });

  it("rejects non-v4 protocol envelopes", () => {
    expect(parseBridgeMessageV4(JSON.stringify({
      type: "sync_request",
      protocol_version: 3,
      host_id: "host-alpha",
      reason: "reconnect",
    }))).toBeNull();
  });

  it("rejects report envelopes with a mismatched host id", () => {
    const vmReport = readFixture<VmReportV1>("vm-report-v1.json");
    expect(parseBridgeMessageV4(JSON.stringify({
      type: "vm_report",
      protocol_version: 4,
      host_id: "host-bravo",
      report: vmReport,
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
