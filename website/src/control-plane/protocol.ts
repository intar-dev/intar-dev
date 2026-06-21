import { asJsonObject, type JsonObject } from "@/lib/json-codec";

const textDecoder = new TextDecoder();

export const HOST_RPC_PROTOCOL_VERSION = 3;
export const MAX_RPC_BATCH_SIZE = 64;

export type HostRpcEnvelopeKind = "rpc.request" | "rpc.response";
export type HostRpcMethod =
  | "vm.launch"
  | "vm.destroy"
  | "vm.list"
  | "vm.terminal.get"
  | "vm.terminal.report"
  | "host.ping";
export type HostTelemetryMethod =
  | "host.heartbeat"
  | "host.inventory.snapshot"
  | "run.probe.snapshot";

export interface RpcEnvelope {
  messageId: string;
  callId: string | null;
  kind: HostRpcEnvelopeKind;
  method: HostRpcMethod;
  occurredAt: number;
  payload: JsonObject;
}

export interface ClientHelloMessage {
  type: "client_hello";
  protocolVersion: number;
  hostId: string;
  sessionId: string;
  agentVersion?: string;
  hostTransportId?: string;
  serverTransportId?: string;
  serverAckedSeq?: number;
  hostAckedSeq?: number;
}

export interface ServerHelloMessage {
  type: "server_hello";
  protocolVersion: number;
  hostId: string;
  sessionId: string;
  serverTransportId: string;
  hostTransportId: string;
  serverAckedSeq: number;
  hostAckedSeq: number;
}

export interface TelemetryMessage {
  type: "telemetry";
  sessionId: string;
  messageId: string;
  method: HostTelemetryMethod;
  occurredAt: number;
  payload: JsonObject;
}

export interface ServerBatchMessage {
  type: "server_batch";
  sessionId: string;
  firstSeq: number;
  lastSeq: number;
  hostAckUpto: number;
  envelopes: RpcEnvelope[];
}

export interface HostBatchMessage {
  type: "host_batch";
  sessionId: string;
  firstSeq: number;
  lastSeq: number;
  serverAckUpto: number;
  envelopes: RpcEnvelope[];
}

export interface ServerAckMessage {
  type: "server_ack";
  sessionId: string;
  ackUpto: number;
}

export interface HostAckMessage {
  type: "host_ack";
  sessionId: string;
  ackUpto: number;
}

export type HostProtocolMessage =
  | ClientHelloMessage
  | ServerHelloMessage
  | TelemetryMessage
  | ServerBatchMessage
  | HostBatchMessage
  | ServerAckMessage
  | HostAckMessage;

export function parseProtocolMessage(
  input: string | ArrayBuffer,
): HostProtocolMessage | null {
  const raw = typeof input === "string" ? input : textDecoder.decode(input);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const body = asJsonObject(parsed);
  if (!body) {
    return null;
  }

  const type = asString(body.type);
  if (!type) {
    return null;
  }

  if (type === "client_hello") {
    const protocolVersion = asNonNegativeInteger(body.protocolVersion);
    const hostId = asString(body.hostId);
    const sessionId = asString(body.sessionId);
    if (
      protocolVersion === undefined ||
      hostId === null ||
      sessionId === null
    ) {
      return null;
    }

    const output: ClientHelloMessage = {
      type,
      protocolVersion,
      hostId,
      sessionId,
    };
    const agentVersion = asString(body.agentVersion);
    const hostTransportId = asString(body.hostTransportId);
    const serverTransportId = asString(body.serverTransportId);
    const serverAckedSeq = asNonNegativeInteger(body.serverAckedSeq);
    const hostAckedSeq = asNonNegativeInteger(body.hostAckedSeq);
    if (agentVersion !== null) output.agentVersion = agentVersion;
    if (hostTransportId !== null) output.hostTransportId = hostTransportId;
    if (serverTransportId !== null)
      output.serverTransportId = serverTransportId;
    if (serverAckedSeq !== undefined) output.serverAckedSeq = serverAckedSeq;
    if (hostAckedSeq !== undefined) output.hostAckedSeq = hostAckedSeq;
    return output;
  }

  if (type === "server_hello") {
    const protocolVersion = asNonNegativeInteger(body.protocolVersion);
    const hostId = asString(body.hostId);
    const sessionId = asString(body.sessionId);
    const serverTransportId = asString(body.serverTransportId);
    const hostTransportId = asString(body.hostTransportId);
    const serverAckedSeq = asNonNegativeInteger(body.serverAckedSeq);
    const hostAckedSeq = asNonNegativeInteger(body.hostAckedSeq);
    if (
      protocolVersion === undefined ||
      hostId === null ||
      sessionId === null ||
      serverTransportId === null ||
      hostTransportId === null ||
      serverAckedSeq === undefined ||
      hostAckedSeq === undefined
    ) {
      return null;
    }

    return {
      type,
      protocolVersion,
      hostId,
      sessionId,
      serverTransportId,
      hostTransportId,
      serverAckedSeq,
      hostAckedSeq,
    };
  }

  if (type === "telemetry") {
    const sessionId = asString(body.sessionId);
    const messageId = asString(body.messageId);
    const method = asTelemetryMethod(body.method);
    const occurredAt = asNonNegativeInteger(body.occurredAt);
    const payload = asJsonObject(body.payload);
    if (
      sessionId === null ||
      messageId === null ||
      method === null ||
      occurredAt === undefined ||
      payload === null
    ) {
      return null;
    }
    return {
      type,
      sessionId,
      messageId,
      method,
      occurredAt,
      payload,
    };
  }

  if (type === "server_batch") {
    const sessionId = asString(body.sessionId);
    const firstSeq = asPositiveInteger(body.firstSeq);
    const lastSeq = asPositiveInteger(body.lastSeq);
    const hostAckUpto = asNonNegativeInteger(body.hostAckUpto);
    const envelopes = normalizeEnvelopes(body.envelopes);
    if (
      sessionId === null ||
      firstSeq === undefined ||
      lastSeq === undefined ||
      hostAckUpto === undefined ||
      envelopes === null ||
      firstSeq > lastSeq ||
      lastSeq - firstSeq + 1 !== envelopes.length
    ) {
      return null;
    }
    return {
      type,
      sessionId,
      firstSeq,
      lastSeq,
      hostAckUpto,
      envelopes,
    };
  }

  if (type === "host_batch") {
    const sessionId = asString(body.sessionId);
    const firstSeq = asPositiveInteger(body.firstSeq);
    const lastSeq = asPositiveInteger(body.lastSeq);
    const serverAckUpto = asNonNegativeInteger(body.serverAckUpto);
    const envelopes = normalizeEnvelopes(body.envelopes);
    if (
      sessionId === null ||
      firstSeq === undefined ||
      lastSeq === undefined ||
      serverAckUpto === undefined ||
      envelopes === null ||
      firstSeq > lastSeq ||
      lastSeq - firstSeq + 1 !== envelopes.length
    ) {
      return null;
    }
    return {
      type,
      sessionId,
      firstSeq,
      lastSeq,
      serverAckUpto,
      envelopes,
    };
  }

  if (type === "server_ack" || type === "host_ack") {
    const sessionId = asString(body.sessionId);
    const ackUpto = asNonNegativeInteger(body.ackUpto);
    if (sessionId === null || ackUpto === undefined) {
      return null;
    }
    return {
      type,
      sessionId,
      ackUpto,
    };
  }

  return null;
}

export function serializeProtocolMessage(message: HostProtocolMessage): string {
  return JSON.stringify(message);
}

export function isHostRpcMethod(value: string): value is HostRpcMethod {
  return (
    value === "vm.launch" ||
    value === "vm.destroy" ||
    value === "vm.list" ||
    value === "vm.terminal.get" ||
    value === "vm.terminal.report" ||
    value === "host.ping"
  );
}

export function isHostTelemetryMethod(
  value: string,
): value is HostTelemetryMethod {
  return (
    value === "host.heartbeat" ||
    value === "host.inventory.snapshot" ||
    value === "run.probe.snapshot"
  );
}

function normalizeEnvelopes(input: unknown): RpcEnvelope[] | null {
  if (!Array.isArray(input)) {
    return null;
  }

  const output: RpcEnvelope[] = [];
  for (const item of input) {
    const envelope = asJsonObject(item);
    if (!envelope) {
      return null;
    }

    const messageId = asString(envelope.messageId);
    const callId = asNullableString(envelope.callId);
    const kind = asEnvelopeKind(envelope.kind);
    const method = asEnvelopeMethod(envelope.method);
    const occurredAt = asNonNegativeInteger(envelope.occurredAt);
    const payload = asJsonObject(envelope.payload);
    if (
      messageId === null ||
      kind === null ||
      method === null ||
      occurredAt === undefined ||
      payload === null
    ) {
      return null;
    }

    output.push({
      messageId,
      callId,
      kind,
      method,
      occurredAt,
      payload,
    });
  }

  return output;
}

function asEnvelopeKind(value: unknown): HostRpcEnvelopeKind | null {
  return value === "rpc.request" || value === "rpc.response" ? value : null;
}

function asEnvelopeMethod(value: unknown): HostRpcMethod | null {
  return typeof value === "string" && isHostRpcMethod(value) ? value : null;
}

function asTelemetryMethod(value: unknown): HostTelemetryMethod | null {
  return typeof value === "string" && isHostTelemetryMethod(value)
    ? value
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}
