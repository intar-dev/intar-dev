import type { BridgeMessageV4, SyncRequestReason } from "@/generated/bridge";
import { BRIDGE_PROTOCOL_VERSION } from "@/generated/constants";

const textDecoder = new TextDecoder();

const MESSAGE_TYPES = new Set<BridgeMessageV4["type"]>([
  "client_hello",
  "server_hello",
  "desired_state",
  "state_report",
  "vm_report",
  "sync_request",
]);

const SYNC_REQUEST_REASONS = new Set<SyncRequestReason>([
  "connect",
  "reconnect",
  "desired_version_lag",
  "operator_requested",
]);

export function parseBridgeMessageV4(
  input: string | ArrayBuffer,
): BridgeMessageV4 | null {
  const value = parseJson(input);
  if (!isRecord(value)) {
    return null;
  }

  const type = readString(value.type);
  if (!type || !isBridgeMessageType(type)) {
    return null;
  }

  if (!hasV4Envelope(value)) {
    return null;
  }

  switch (type) {
    case "client_hello":
      return isClientHello(value) ? value : null;
    case "server_hello":
      return isServerHello(value) ? value : null;
    case "desired_state":
      return isDesiredState(value) ? value : null;
    case "state_report":
      return isStateReport(value) ? value : null;
    case "vm_report":
      return isVmReport(value) ? value : null;
    case "sync_request":
      return isSyncRequest(value) ? value : null;
  }
}

export function serializeBridgeMessageV4(message: BridgeMessageV4): string {
  return JSON.stringify(message);
}

function parseJson(input: string | ArrayBuffer): unknown {
  const raw = typeof input === "string" ? input : textDecoder.decode(input);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function hasV4Envelope(value: Record<string, unknown>): boolean {
  return (
    value.protocol_version === BRIDGE_PROTOCOL_VERSION &&
    typeof value.host_id === "string" &&
    value.host_id.trim().length > 0
  );
}

function isClientHello(
  value: unknown,
): value is Extract<BridgeMessageV4, { type: "client_hello" }> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    readString(value.agent_version) !== null &&
    isRecord(value.capabilities) &&
    isOptionalNumber(value.last_applied_desired_version)
  );
}

function isServerHello(
  value: unknown,
): value is Extract<BridgeMessageV4, { type: "server_hello" }> {
  if (!isRecord(value)) {
    return false;
  }
  return isNonNegativeInteger(value.desired_version);
}

function isDesiredState(
  value: unknown,
): value is Extract<BridgeMessageV4, { type: "desired_state" }> {
  if (!isRecord(value)) {
    return false;
  }
  const desiredState = value.desired_state;
  return (
    isRecord(desiredState) &&
    desiredState.host_id === value.host_id &&
    isNonNegativeInteger(desiredState.version)
  );
}

function isStateReport(
  value: unknown,
): value is Extract<BridgeMessageV4, { type: "state_report" }> {
  if (!isRecord(value)) {
    return false;
  }
  const report = value.report;
  return (
    isRecord(report) &&
    report.host_id === value.host_id &&
    isNonNegativeInteger(report.applied_desired_version)
  );
}

function isVmReport(
  value: unknown,
): value is Extract<BridgeMessageV4, { type: "vm_report" }> {
  if (!isRecord(value)) {
    return false;
  }
  const report = value.report;
  return (
    isRecord(report) &&
    report.host_id === value.host_id &&
    readString(report.run_id) !== null &&
    readString(report.vm_name) !== null
  );
}

function isSyncRequest(
  value: unknown,
): value is Extract<BridgeMessageV4, { type: "sync_request" }> {
  if (!isRecord(value)) {
    return false;
  }
  const reason = readString(value.reason);
  return reason !== null && SYNC_REQUEST_REASONS.has(reason as SyncRequestReason);
}

function isBridgeMessageType(value: string): value is BridgeMessageV4["type"] {
  return MESSAGE_TYPES.has(value as BridgeMessageV4["type"]);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
