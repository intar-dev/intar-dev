import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  HOST_RPC_PROTOCOL_VERSION,
  MAX_RPC_BATCH_SIZE,
  isHostRpcMethod,
  parseProtocolMessage,
  serializeProtocolMessage,
  type ClientHelloMessage,
  type HostBatchMessage,
  type HostRpcMethod,
  type RpcEnvelope,
  type ServerAckMessage,
  type ServerBatchMessage,
  type TelemetryMessage,
} from "@/control-plane/protocol";
import {
  applyProbePhaseHeuristics,
  shouldQueueTerminalStateGet,
} from "@/control-plane/host-runtime-boot-probes";
import {
  agentHosts,
  agentPingAudit,
  hostRpcCalls,
  hostRpcEnvelopes,
  hostRpcReceipts,
  scenarioRunProbeSnapshots,
  scenarioRuns,
} from "@/db/schema";
import { createAppId } from "@/lib/id";
import {
  RUN_PHASE_ORDER,
  applyProbeSnapshotToVm,
  buildInitialRunState,
  canAdvanceRunPhase,
  canAdvanceVmPhase,
  decorateVmState,
  recomputeRunState,
  type RunPhase,
  type RunStateDocument,
  type RunVmStateDocument,
  type VmPhase,
} from "@/lib/run-state";
import { nextSolvedAt } from "@/lib/scenario-run-outcome";

const CONNECTED_RESEND_INTERVAL_MS = 3_000;
const DISCONNECTED_RESEND_INTERVAL_MS = 15_000;
const HOST_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface SocketAttachment {
  hostId: string;
  sessionId: string | null;
  connectedAt: number;
  helloReceived: boolean;
}

interface InventorySnapshotPayload {
  generatedAt?: number | null;
  generation?: string | null;
  vms?: unknown[];
}

interface ProbeSnapshotPayload {
  runId?: string | null;
  vmName?: string | null;
  generatedAtMs?: number | null;
  collectionState?: string | null;
  collectionError?: string | null;
  summary?: Record<string, unknown> | null;
  probes?: Array<Record<string, unknown>> | null;
}

interface TerminalStatePayload {
  runId?: string | null;
  vmName?: string | null;
  state?: string | null;
  terminalTarget?: Record<string, unknown> | null;
  terminal_target?: Record<string, unknown> | null;
  reason?: string | null;
  observedAt?: number | null;
  observed_at?: number | null;
}

type InboundBatchPlan =
  | { kind: "ack_only" }
  | { kind: "gap" }
  | { kind: "process"; startIndex: number };

type PersistedHostRpcCall = typeof hostRpcCalls.$inferSelect;

export class HostRuntimeDO extends DurableObject<Cloudflare.Env> {
  constructor(
    ctx: DurableObjectState,
    override readonly env: Cloudflare.Env,
  ) {
    super(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request);
    }

    if (url.pathname === "/_internal/wake") {
      return this.handleWake(request);
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  override async alarm(): Promise<void> {
    const hostId = await this.loadKnownHostId();
    if (!hostId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.reconcileHost(hostId);
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = this.readSocketAttachment(ws);
    if (!attachment) {
      try {
        ws.close(1008, "missing attachment");
      } catch {
        // ignore
      }
      return;
    }

    const parsed = parseProtocolMessage(message);
    if (!parsed) {
      try {
        ws.close(1003, "invalid message");
      } catch {
        // ignore
      }
      return;
    }

    if (parsed.type === "client_hello") {
      await this.handleClientHello(ws, attachment, parsed);
      return;
    }

    if (!attachment.helloReceived || !attachment.sessionId) {
      try {
        ws.close(1008, "client hello required");
      } catch {
        // ignore
      }
      return;
    }

    if (parsed.type === "host_batch") {
      await this.handleRpcBatch(ws, attachment, parsed);
      return;
    }

    if (parsed.type === "telemetry") {
      await this.handleTelemetry(attachment, parsed);
      return;
    }

    if (parsed.type === "server_ack") {
      await this.handleRpcAck(attachment, parsed);
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.handleSocketClosed(ws);
  }

  private async handleConnect(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "expected websocket upgrade" }, 400);
    }

    const hostId = request.headers.get("x-agent-host-id")?.trim() ?? "";
    if (!hostId) {
      return jsonResponse({ error: "missing host id" }, 400);
    }

    await this.persistKnownHostId(hostId);

    const connectedAt = Date.now();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, ["host", `host:${hostId}`]);

    server.serializeAttachment({
      hostId,
      sessionId: null,
      connectedAt,
      helloReceived: false,
    } satisfies SocketAttachment);

    await this.scheduleNextAlarm(hostId);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleWake(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    const hostId = await this.resolveKnownHostId(request);
    if (!hostId) {
      return jsonResponse({ error: "host id is unknown" }, 409);
    }

    await this.ctx.storage.setAlarm(Math.max(0, Date.now() - 1));
    return jsonResponse({ ok: true, hostId }, 202);
  }

  private async handleClientHello(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: ClientHelloMessage,
  ): Promise<void> {
    if (message.protocolVersion !== HOST_RPC_PROTOCOL_VERSION) {
      try {
        ws.close(1002, "invalid protocol version");
      } catch {
        // ignore
      }
      return;
    }

    if (message.hostId !== attachment.hostId) {
      try {
        ws.close(1008, "host mismatch");
      } catch {
        // ignore
      }
      return;
    }

    const now = Date.now();
    let host = await this.loadRequiredHost(message.hostId);
    const requestedServerTransportId = normalizeTransportId(
      message.serverTransportId,
    );
    const requestedHostTransportId = normalizeTransportId(
      message.hostTransportId,
    );
    const currentServerTransportId = normalizeTransportId(
      host.serverTransportId,
    );
    const currentHostTransportId = normalizeTransportId(host.hostTransportId);
    const resumeServerLane = shouldResumeTransportLane(
      currentServerTransportId,
      requestedServerTransportId,
      host.serverNextSeq,
      host.serverAckedSeq,
      message.serverAckedSeq ?? 0,
    );
    const resumeHostLane = shouldResumeTransportLane(
      currentHostTransportId,
      requestedHostTransportId,
      host.hostNextSeq,
      host.hostAckedSeq,
      message.hostAckedSeq ?? 0,
    );
    const nextServerTransportId = resumeServerLane
      ? (currentServerTransportId ?? createAppId())
      : createAppId();
    const nextHostTransportId = resumeHostLane
      ? (currentHostTransportId ?? requestedHostTransportId ?? createAppId())
      : createAppId();

    let didResetServerTransport = false;
    if (!resumeServerLane) {
      await this.resetServerToHostTransport(message.hostId, now);
      host = {
        ...host,
        serverNextSeq: 1,
        serverAckedSeq: 0,
        serverTransportId: nextServerTransportId,
      };
      didResetServerTransport = true;
    }

    let didResetHostTransport = false;
    if (!resumeHostLane) {
      await this.resetHostToServerTransport(message.hostId, now);
      host = {
        ...host,
        hostNextSeq: 1,
        hostAckedSeq: 0,
        hostTransportId: nextHostTransportId,
      };
      didResetHostTransport = true;
    }

    const serverAckedSeq = resumeServerLane
      ? clampAck(
          host.serverNextSeq,
          host.serverAckedSeq,
          message.serverAckedSeq ?? host.serverAckedSeq,
        )
      : 0;
    const hostAckedSeq = resumeHostLane
      ? clampAck(
          host.hostNextSeq,
          host.hostAckedSeq,
          message.hostAckedSeq ?? host.hostAckedSeq,
        )
      : 0;

    const nextAttachment: SocketAttachment = {
      ...attachment,
      sessionId: message.sessionId,
      helloReceived: true,
    };
    ws.serializeAttachment(nextAttachment);

    await this.persistKnownHostId(message.hostId);
    await this.updateHostRow(message.hostId, {
      activeSessionId: message.sessionId,
      connected: true,
      connectedAt: host.connectedAt ?? now,
      disconnectedAt: null,
      lastClientHelloAt: now,
      lastServerHelloAt: now,
      agentVersion: message.agentVersion ?? host.agentVersion,
      serverAckedSeq,
      hostAckedSeq,
      serverTransportId: nextServerTransportId,
      hostTransportId: nextHostTransportId,
      updatedAt: now,
    });

    await this.closeOlderSockets(message.hostId, ws, message.sessionId);

    ws.send(
      serializeProtocolMessage({
        type: "server_hello",
        protocolVersion: HOST_RPC_PROTOCOL_VERSION,
        hostId: message.hostId,
        sessionId: message.sessionId,
        serverTransportId: nextServerTransportId,
        hostTransportId: nextHostTransportId,
        serverAckedSeq,
        hostAckedSeq,
      }),
    );

    if (didResetHostTransport || didResetServerTransport) {
      await this.scheduleNextAlarm(message.hostId);
    }
    await this.queueMissingTerminalStateRefreshes(message.hostId);
    await this.reconcileHost(message.hostId);
  }

  private async handleRpcAck(
    attachment: SocketAttachment,
    message: ServerAckMessage,
  ): Promise<void> {
    if (!attachment.sessionId || message.sessionId !== attachment.sessionId) {
      return;
    }

    const now = Date.now();
    const host = await this.loadRequiredHost(attachment.hostId);
    if (host.activeSessionId !== attachment.sessionId) {
      return;
    }

    const ackUpto = clampAck(
      host.serverNextSeq,
      host.serverAckedSeq,
      message.ackUpto,
    );
    await this.updateHostRow(attachment.hostId, {
      serverAckedSeq: ackUpto,
      updatedAt: now,
    });

    const db = drizzle(this.env.DB);
    const envelopes = await db
      .select({
        seq: hostRpcEnvelopes.seq,
        callId: hostRpcEnvelopes.callId,
        messageId: hostRpcEnvelopes.messageId,
        kind: hostRpcEnvelopes.kind,
      })
      .from(hostRpcEnvelopes)
      .where(
        and(
          eq(hostRpcEnvelopes.hostId, attachment.hostId),
          eq(hostRpcEnvelopes.direction, "server_to_host"),
          lte(hostRpcEnvelopes.seq, ackUpto),
          isNull(hostRpcEnvelopes.ackedAt),
        ),
      );

    if (envelopes.length) {
      const requestCallIds: string[] = [];
      await db
        .update(hostRpcEnvelopes)
        .set({ ackedAt: now })
        .where(
          and(
            eq(hostRpcEnvelopes.hostId, attachment.hostId),
            eq(hostRpcEnvelopes.direction, "server_to_host"),
            lte(hostRpcEnvelopes.seq, ackUpto),
            isNull(hostRpcEnvelopes.ackedAt),
          ),
        );

      for (const envelope of envelopes) {
        if (!envelope.callId) {
          continue;
        }
        if (envelope.kind === "rpc.request") {
          requestCallIds.push(envelope.callId);
          await db
            .update(hostRpcCalls)
            .set({
              requestAckedAt: now,
              status: "request_acked",
              updatedAt: now,
            })
            .where(eq(hostRpcCalls.callId, envelope.callId));
        } else if (envelope.kind === "rpc.response") {
          await db
            .update(hostRpcCalls)
            .set({
              responseAckedAt: now,
              updatedAt: now,
            })
            .where(eq(hostRpcCalls.callId, envelope.callId));
        }
      }

      for (const callId of requestCallIds) {
        await this.syncRunStateForServerCall(callId, now);
      }
    }

    await this.reconcileHost(attachment.hostId);
  }

  private async handleTelemetry(
    attachment: SocketAttachment,
    message: TelemetryMessage,
  ): Promise<void> {
    if (!attachment.sessionId || message.sessionId !== attachment.sessionId) {
      return;
    }

    const host = await this.loadRequiredHost(attachment.hostId);
    if (host.activeSessionId !== attachment.sessionId) {
      return;
    }

    const now = Date.now();
    if (message.method === "host.heartbeat") {
      await this.applyHeartbeatEvent(attachment.hostId, message.payload, now);
    } else if (message.method === "host.inventory.snapshot") {
      await this.applyInventorySnapshotEvent(
        attachment.hostId,
        message.payload,
        now,
      );
    } else {
      await this.applyProbeSnapshot(
        attachment.hostId,
        message.messageId,
        message.payload as ProbeSnapshotPayload,
        now,
      );
    }

    await this.reconcileHost(attachment.hostId);
  }

  private async handleRpcBatch(
    ws: WebSocket,
    attachment: SocketAttachment,
    batch: HostBatchMessage,
  ): Promise<void> {
    if (!attachment.sessionId || batch.sessionId !== attachment.sessionId) {
      return;
    }

    const host = await this.loadRequiredHost(attachment.hostId);
    if (host.activeSessionId !== attachment.sessionId) {
      return;
    }

    if (batch.serverAckUpto > host.serverAckedSeq) {
      await this.handleRpcAck(attachment, {
        type: "server_ack",
        sessionId: attachment.sessionId,
        ackUpto: batch.serverAckUpto,
      });
    }

    const db = drizzle(this.env.DB);
    const now = Date.now();
    await this.pruneExpiredHostReceipts(attachment.hostId, now);
    const plan = planInboundBatch(
      host.hostAckedSeq,
      batch.firstSeq,
      batch.lastSeq,
      batch.envelopes.length,
    );
    if (plan.kind === "gap") {
      const nextHostTransportId = createAppId();
      await this.resetHostToServerTransport(attachment.hostId, now);
      await this.updateHostRow(attachment.hostId, {
        hostTransportId: nextHostTransportId,
        updatedAt: now,
      });
      try {
        ws.close(1011, "host transport reset required");
      } catch {
        // ignore
      }
      return;
    }

    if (plan.kind === "ack_only") {
      ws.send(
        serializeProtocolMessage({
          type: "host_ack",
          sessionId: attachment.sessionId,
          ackUpto: host.hostAckedSeq,
        }),
      );
      return;
    }

    const hostTransportId = normalizeTransportId(host.hostTransportId);
    if (!hostTransportId) {
      const nextHostTransportId = createAppId();
      await this.resetHostToServerTransport(attachment.hostId, now);
      await this.updateHostRow(attachment.hostId, {
        hostTransportId: nextHostTransportId,
        updatedAt: now,
      });
      try {
        ws.close(1011, "host transport reset required");
      } catch {
        // ignore
      }
      return;
    }

    for (
      let index = plan.startIndex;
      index < batch.envelopes.length;
      index += 1
    ) {
      const envelope = batch.envelopes[index];
      if (!envelope) {
        continue;
      }
      const payloadJson = JSON.stringify(envelope.payload);

      const receipt = await db
        .select({
          id: hostRpcReceipts.id,
          callId: hostRpcReceipts.callId,
          kind: hostRpcReceipts.kind,
          method: hostRpcReceipts.method,
          payloadJson: hostRpcReceipts.payloadJson,
        })
        .from(hostRpcReceipts)
        .where(
          and(
            eq(hostRpcReceipts.hostId, attachment.hostId),
            eq(hostRpcReceipts.transportId, hostTransportId),
            eq(hostRpcReceipts.messageId, envelope.messageId),
          ),
        )
        .limit(1);
      const existingReceipt = receipt[0];
      if (existingReceipt) {
        if (
          existingReceipt.kind !== envelope.kind ||
          existingReceipt.method !== envelope.method ||
          existingReceipt.callId !== envelope.callId ||
          existingReceipt.payloadJson !== payloadJson
        ) {
          const nextHostTransportId = createAppId();
          await this.resetHostToServerTransport(attachment.hostId, now);
          await this.updateHostRow(attachment.hostId, {
            hostTransportId: nextHostTransportId,
            updatedAt: now,
          });
          try {
            ws.close(1011, "host transport reset required");
          } catch {
            // ignore
          }
          return;
        }
        continue;
      }

      await db.insert(hostRpcReceipts).values({
        id: createAppId(),
        hostId: attachment.hostId,
        transportId: hostTransportId,
        messageId: envelope.messageId,
        callId: envelope.callId,
        kind: envelope.kind,
        method: envelope.method,
        payloadJson,
        receivedAt: now,
        expiresAt: now + HOST_RECEIPT_RETENTION_MS,
        createdAt: now,
      });

      await this.applyInboundEnvelope(attachment.hostId, envelope, now);
    }

    await this.updateHostRow(attachment.hostId, {
      hostNextSeq: Math.max(host.hostNextSeq, batch.lastSeq + 1),
      hostAckedSeq: Math.max(host.hostAckedSeq, batch.lastSeq),
      updatedAt: now,
    });

    ws.send(
      serializeProtocolMessage({
        type: "host_ack",
        sessionId: attachment.sessionId,
        ackUpto: batch.lastSeq,
      }),
    );

    await this.reconcileHost(attachment.hostId);
  }

  private async pruneExpiredHostReceipts(
    hostId: string,
    now: number,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    await db
      .delete(hostRpcReceipts)
      .where(
        and(
          eq(hostRpcReceipts.hostId, hostId),
          lte(hostRpcReceipts.expiresAt, now),
        ),
      );
  }

  private async applyInboundEnvelope(
    hostId: string,
    envelope: RpcEnvelope,
    now: number,
  ): Promise<void> {
    if (envelope.kind === "rpc.response") {
      await this.applyHostResponse(hostId, envelope, now);
      return;
    }

    await this.applyHostRequest(hostId, envelope, now);
  }

  private async applyHostResponse(
    hostId: string,
    envelope: RpcEnvelope,
    now: number,
  ): Promise<void> {
    if (!envelope.callId) {
      return;
    }

    const db = drizzle(this.env.DB);
    const callRows = await db
      .select()
      .from(hostRpcCalls)
      .where(eq(hostRpcCalls.callId, envelope.callId))
      .limit(1);
    const call = callRows[0];
    if (!call) {
      return;
    }

    const status = resolveCallStatus(envelope.payload);
    const response = resolveCallResponse(envelope.payload);
    const error = resolveCallError(envelope.payload);
    const startedAt = readNumber(envelope.payload.startedAt) ?? call.startedAt;
    const finishedAt =
      readNumber(envelope.payload.finishedAt) ??
      (status === "running" ? null : now) ??
      call.finishedAt;

    await db
      .update(hostRpcCalls)
      .set({
        status,
        responseMessageId: envelope.messageId,
        responseJson: response === null ? null : JSON.stringify(response),
        errorJson: error === null ? null : JSON.stringify(error),
        startedAt,
        finishedAt,
        responseAckedAt: now,
        updatedAt: now,
      })
      .where(eq(hostRpcCalls.callId, call.callId));

    if (call.method === "host.ping") {
      const success = status === "succeeded";
      const rttMs = readNumber(envelope.payload.rttMs);
      await this.updateHostRow(hostId, {
        lastPingAt: now,
        lastPingRttMs: rttMs,
        lastPingSuccess: success,
        lastPingError: success
          ? null
          : (stringifyUnknown(error) ?? "ping failed"),
        updatedAt: now,
      });
      await db.insert(agentPingAudit).values({
        id: createAppId(),
        hostId,
        requestedByUserId:
          call.userId ?? (await this.loadRequiredHost(hostId)).userId,
        requestedAt: now,
        success,
        rttMs,
        error: success ? null : stringifyUnknown(error),
      });
    } else if (call.method === "vm.list" && isRecord(response)) {
      await this.applyInventorySnapshotEvent(
        hostId,
        {
          generatedAt: readNumber(response.generatedAt) ?? now,
          generation:
            (typeof response.generation === "string"
              ? response.generation
              : null) ?? createAppId(),
          vms: Array.isArray(response.vms) ? response.vms : [],
        } satisfies InventorySnapshotPayload,
        now,
      );
    } else if (call.method === "vm.terminal.get" && isRecord(response)) {
      await this.applyTerminalStateEvent(
        hostId,
        response as TerminalStatePayload,
      );
    }

    if (call.runId && call.vmId) {
      if (call.method === "vm.launch") {
        await this.applyVmLaunchResponse(
          call.runId,
          call.vmId,
          status,
          response,
          error,
          now,
        );
      } else if (call.method === "vm.destroy") {
        await this.applyVmDestroyResponse(
          call.runId,
          call.vmId,
          status,
          response,
          error,
          now,
        );
      }
    }
  }

  private async applyHostRequest(
    hostId: string,
    envelope: RpcEnvelope,
    now: number,
  ): Promise<void> {
    if (!isHostRpcMethod(envelope.method)) {
      return;
    }

    const db = drizzle(this.env.DB);
    const callId = envelope.callId ?? createAppId();

    const existing = await db
      .select({ callId: hostRpcCalls.callId })
      .from(hostRpcCalls)
      .where(eq(hostRpcCalls.callId, callId))
      .limit(1);

    if (!existing.length) {
      await db.insert(hostRpcCalls).values({
        callId,
        hostId,
        userId: null,
        runId: null,
        vmId: null,
        direction: "host_to_server",
        method: envelope.method,
        status: "request_acked",
        idempotencyKey: null,
        requestMessageId: envelope.messageId,
        responseMessageId: null,
        requestJson: JSON.stringify(envelope.payload),
        responseJson: null,
        errorJson: null,
        requestAckedAt: now,
        responseAckedAt: null,
        startedAt: now,
        finishedAt: null,
        deadlineAt: null,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      });
    }

    const payload = envelope.payload as Record<string, unknown>;
    let responsePayload: Record<string, unknown>;
    let status: "succeeded" | "failed" = "succeeded";
    let errorJson: unknown = null;

    if (envelope.method === "vm.terminal.report") {
      await this.applyTerminalStateEvent(
        hostId,
        payload as TerminalStatePayload,
      );
      responsePayload = {
        status: "succeeded",
        result: payload,
        finishedAt: now,
      };
    } else {
      status = "failed";
      errorJson = {
        code: "not_implemented",
        message: `server does not handle ${envelope.method}`,
      };
      responsePayload = {
        status: "failed",
        error: errorJson,
        finishedAt: now,
      };
    }

    const response = await this.queueServerEnvelope(hostId, {
      callId,
      kind: "rpc.response",
      method: envelope.method,
      payload: responsePayload,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    });

    await db
      .update(hostRpcCalls)
      .set({
        status,
        responseMessageId: response.messageId,
        responseJson: JSON.stringify(responsePayload),
        errorJson: errorJson === null ? null : JSON.stringify(errorJson),
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(hostRpcCalls.callId, callId));
  }

  private async applyHeartbeatEvent(
    hostId: string,
    payload: Record<string, unknown>,
    now: number,
  ): Promise<void> {
    await this.updateHostRow(hostId, {
      connected: true,
      disconnectedAt: null,
      lastHeartbeatAt: readNumber(payload.heartbeatAt) ?? now,
      hostInfoJson: serializeJson(
        isRecord(payload.hostInfo) ? payload.hostInfo : null,
      ),
      updatedAt: now,
    });
  }

  private async applyInventorySnapshotEvent(
    hostId: string,
    payload: Record<string, unknown>,
    now: number,
  ): Promise<void> {
    const inventory = {
      generatedAt: readNumber(payload.generatedAt) ?? now,
      generation:
        (typeof payload.generation === "string" ? payload.generation : null) ??
        createAppId(),
      vms: Array.isArray(payload.vms) ? payload.vms : [],
    } satisfies Required<InventorySnapshotPayload>;

    await this.updateHostRow(hostId, {
      lastInventoryAt: now,
      inventoryJson: JSON.stringify(inventory),
      updatedAt: now,
    });

    const runs = await this.listOpenRunsForHost(hostId);
    const nextRuns = runs.map((run) => ({
      run,
      nextState: {
        ...run.state,
        vms: run.state.vms.map((vm) => {
          const inventoryVm = inventory.vms.find((item) =>
            matchesInventoryVm(item, run.runId, vm.runtimeVmName),
          );
          if (!inventoryVm || !isRecord(inventoryVm)) {
            return vm;
          }

          let nextVm = { ...vm };
          const inventoryPhase = inferVmPhaseFromInventory(inventoryVm, nextVm);
          if (
            inventoryPhase &&
            canAdvanceVmPhase(nextVm.phase, inventoryPhase)
          ) {
            nextVm = decorateVmState({
              ...nextVm,
              phase: inventoryPhase,
              phaseDetail:
                inventoryPhase === "ready"
                  ? "Inventory confirms the VM is running."
                  : nextVm.phaseDetail,
            });
          }

          return nextVm;
        }),
      } satisfies RunStateDocument,
    }));

    for (const { run, nextState } of nextRuns) {
      await this.persistRunState(run.runId, nextState, {
        keepDeleteRequestedAt: true,
      });
    }
  }

  private async applyProbeSnapshot(
    hostId: string,
    messageId: string,
    payload: ProbeSnapshotPayload,
    now: number,
  ): Promise<void> {
    const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
    const runtimeVmName =
      typeof payload.vmName === "string" ? payload.vmName.trim() : "";
    if (!runId || !runtimeVmName) {
      return;
    }

    const run = await this.loadRun(runId);
    if (!run || run.hostId !== hostId) {
      return;
    }

    const vm = run.state.vms.find(
      (candidate) => candidate.runtimeVmName === runtimeVmName,
    );
    if (!vm) {
      return;
    }

    const db = drizzle(this.env.DB);
    await db
      .insert(scenarioRunProbeSnapshots)
      .values({
        id: createAppId(),
        runId,
        vmId: vm.id,
        runtimeVmName,
        messageId,
        collectionState:
          typeof payload.collectionState === "string"
            ? payload.collectionState
            : null,
        collectionError:
          typeof payload.collectionError === "string"
            ? payload.collectionError
            : null,
        summaryJson: serializeJson(payload.summary ?? null),
        snapshotJson: JSON.stringify(payload),
        generatedAt: payload.generatedAtMs ?? null,
        observedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing();

    const nextState = {
      ...run.state,
      vms: run.state.vms.map((candidate) => {
        if (candidate.id !== vm.id) {
          return candidate;
        }
        const updated = applyProbeSnapshotToVm(candidate, {
          probes: payload.probes?.filter(isRecord) ?? null,
        });
        return applyProbePhaseHeuristics(
          updated,
          payload.collectionError ?? null,
        );
      }),
    } satisfies RunStateDocument;

    await this.persistRunState(runId, nextState, {
      keepDeleteRequestedAt: true,
    });
    await this.queueTerminalStateGetIfNeeded(
      hostId,
      runId,
      vm.id,
      nextState.vms.find((candidate) => candidate.id === vm.id) ?? null,
      { requireBootPassing: true },
    );
  }

  private async applyVmLaunchResponse(
    runId: string,
    vmId: string,
    status: string,
    response: unknown,
    error: unknown,
    now: number,
  ): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run) {
      return;
    }

    const nextState = {
      ...run.state,
      vms: run.state.vms.map((vm) => {
        if (vm.id !== vmId) {
          return vm;
        }

        if (status === "failed" || status === "timed_out") {
          return decorateVmState({
            ...vm,
            phase: "failed",
            phaseDetail: stringifyUnknown(error) ?? "VM launch failed.",
          });
        }

        const nextVm = decorateVmState({
          ...vm,
          phase: canAdvanceVmPhase(vm.phase, "booting") ? "booting" : vm.phase,
          phaseDetail: "Launch request completed. Waiting for boot probes.",
          vmCreatedAt:
            readNestedNumber(response, "createdAt") ?? vm.vmCreatedAt ?? now,
        });
        return nextVm;
      }),
    } satisfies RunStateDocument;

    await this.persistRunState(runId, nextState, {
      keepDeleteRequestedAt: true,
    });
    await this.queueTerminalStateGetIfNeeded(
      run.hostId,
      runId,
      vmId,
      nextState.vms.find((vm) => vm.id === vmId) ?? null,
    );
  }

  private async applyVmDestroyResponse(
    runId: string,
    vmId: string,
    status: string,
    _response: unknown,
    error: unknown,
    now: number,
  ): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run) {
      return;
    }

    const nextState = {
      ...run.state,
      vms: run.state.vms.map((vm) => {
        if (vm.id !== vmId) {
          return vm;
        }

        if (status === "failed" || status === "timed_out") {
          return decorateVmState({
            ...vm,
            phase: "failed",
            phaseDetail: stringifyUnknown(error) ?? "VM destroy failed.",
          });
        }

        return decorateVmState({
          ...vm,
          phase: canAdvanceVmPhase(vm.phase, "destroying")
            ? "destroying"
            : vm.phase,
          phaseDetail:
            "Teardown accepted. Waiting for local cleanup to finish.",
        });
      }),
    } satisfies RunStateDocument;

    const terminal = nextState.vms.every(
      (vm) =>
        vm.phase === "archived" ||
        vm.phase === "completed" ||
        vm.phase === "failed",
    )
      ? advanceRunPhase(nextState.phase, "archiving")
      : advanceRunPhase(nextState.phase, "tearing_down");

    await this.persistRunState(
      runId,
      {
        ...nextState,
        phase: terminal,
      },
      {
        deleteRequestedAt: run.deleteRequestedAt ?? now,
      },
    );
  }

  private async reconcileHost(hostId: string): Promise<void> {
    await this.materializeQueuedCalls(hostId);

    const activeSocket = await this.findActiveSocket(hostId);
    if (activeSocket) {
      await this.dispatchPendingServerEnvelopes(
        hostId,
        activeSocket.socket,
        activeSocket.attachment,
      );
    }

    await this.markTimedOutCalls(hostId);
    await this.scheduleNextAlarm(hostId);
  }

  private async materializeQueuedCalls(hostId: string): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    const queued = await db
      .select()
      .from(hostRpcCalls)
      .where(
        and(
          eq(hostRpcCalls.hostId, hostId),
          eq(hostRpcCalls.direction, "server_to_host"),
          inArray(hostRpcCalls.status, [
            "queued",
            "sent",
            "request_acked",
            "running",
          ]),
        ),
      )
      .orderBy(asc(hostRpcCalls.createdAt))
      .limit(MAX_RPC_BATCH_SIZE);

    for (const call of queued) {
      if (call.expiresAt !== null && call.expiresAt <= now) {
        continue;
      }
      if (call.requestMessageId) {
        continue;
      }

      const response = await this.queueServerEnvelope(hostId, {
        callId: call.callId,
        kind: "rpc.request",
        method: call.method as HostRpcMethod,
        payload: parseJsonRecord(call.requestJson),
        expiresAt: call.expiresAt,
      });

      await db
        .update(hostRpcCalls)
        .set({
          requestMessageId: response.messageId,
          status: "sent" as const,
          updatedAt: now,
        })
        .where(eq(hostRpcCalls.callId, call.callId));
      await this.syncRunStateForServerCall(call.callId, now);
    }
  }

  private async dispatchPendingServerEnvelopes(
    hostId: string,
    ws: WebSocket,
    attachment: SocketAttachment,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const host = await this.loadRequiredHost(hostId);
    if (
      !attachment.sessionId ||
      host.activeSessionId !== attachment.sessionId
    ) {
      return;
    }

    const pending = await db
      .select()
      .from(hostRpcEnvelopes)
      .where(
        and(
          eq(hostRpcEnvelopes.hostId, hostId),
          eq(hostRpcEnvelopes.direction, "server_to_host"),
          isNull(hostRpcEnvelopes.ackedAt),
        ),
      )
      .orderBy(asc(hostRpcEnvelopes.seq))
      .limit(MAX_RPC_BATCH_SIZE);

    if (!pending.length) {
      return;
    }

    const contiguous: typeof pending = [];
    let expectedSeq = pending[0]?.seq ?? 0;
    for (const row of pending) {
      if (row.seq !== expectedSeq) {
        break;
      }
      contiguous.push(row);
      expectedSeq += 1;
    }
    if (!contiguous.length) {
      return;
    }
    const first = contiguous[0];
    const last = contiguous[contiguous.length - 1];
    if (!first || !last) {
      return;
    }

    const now = Date.now();
    await db
      .update(hostRpcEnvelopes)
      .set({ sessionId: attachment.sessionId })
      .where(
        inArray(
          hostRpcEnvelopes.id,
          contiguous.map((row) => row.id),
        ),
      );

    const batchMessage: ServerBatchMessage = {
      type: "server_batch",
      sessionId: attachment.sessionId,
      firstSeq: first.seq,
      lastSeq: last.seq,
      hostAckUpto: host.hostAckedSeq,
      envelopes: contiguous.map((row) => ({
        messageId: row.messageId,
        callId: row.callId,
        kind: row.kind as RpcEnvelope["kind"],
        method: row.method as RpcEnvelope["method"],
        occurredAt: row.occurredAt,
        payload: parseJsonRecord(row.payloadJson) as RpcEnvelope["payload"],
      })),
    };
    ws.send(serializeProtocolMessage(batchMessage));

    await this.updateHostRow(hostId, {
      lastServerHelloAt: host.lastServerHelloAt ?? now,
      updatedAt: now,
    });
  }

  private async markTimedOutCalls(hostId: string): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    const rows = await db
      .select()
      .from(hostRpcCalls)
      .where(
        and(
          eq(hostRpcCalls.hostId, hostId),
          inArray(hostRpcCalls.status, [
            "queued",
            "sent",
            "request_acked",
            "running",
          ]),
          lte(hostRpcCalls.deadlineAt, now),
        ),
      );

    for (const call of rows) {
      await db
        .update(hostRpcCalls)
        .set({
          status: "timed_out",
          errorJson: JSON.stringify({
            code: "deadline_exceeded",
            message: "RPC deadline exceeded",
          }),
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(hostRpcCalls.callId, call.callId));

      if (call.method === "vm.terminal.get") {
        continue;
      }

      if (call.runId && call.vmId) {
        const run = await this.loadRun(call.runId);
        if (!run) {
          continue;
        }
        const nextState = {
          ...run.state,
          vms: run.state.vms.map((vm) =>
            vm.id === call.vmId
              ? decorateVmState({
                  ...vm,
                  phase: "failed",
                  phaseDetail: `${call.method} timed out.`,
                })
              : vm,
          ),
        } satisfies RunStateDocument;
        await this.persistRunState(call.runId, nextState, {
          keepDeleteRequestedAt: true,
        });
      }
    }
  }

  private async persistRunState(
    runId: string,
    nextState: RunStateDocument,
    options?: {
      deleteRequestedAt?: number | null;
      keepDeleteRequestedAt?: boolean;
    },
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const row = await this.loadRun(runId);
    if (!row) {
      return;
    }

    const current = recomputeRunState(row.state);
    const recomputed = recomputeRunState(nextState);
    const phase = canAdvanceRunPhase(current.phase, recomputed.phase)
      ? recomputed.phase
      : current.phase;
    const merged =
      phase === recomputed.phase
        ? recomputed
        : {
            ...recomputed,
            phase,
          };

    const now = Date.now();
    const deleteRequestedAt = options?.keepDeleteRequestedAt
      ? row.deleteRequestedAt
      : (options?.deleteRequestedAt ?? row.deleteRequestedAt);
    const solvedAt = nextSolvedAt({
      currentPhase: current.phase,
      nextPhase: merged.phase,
      existingSolvedAt: row.solvedAt,
      now,
    });
    const completedAt =
      merged.phase === "completed" ? (row.completedAt ?? now) : null;
    const failedAt = merged.phase === "failed" ? (row.failedAt ?? now) : null;
    const nextActiveKey =
      merged.phase === "completed" || merged.phase === "failed"
        ? null
        : row.activeKey;
    const currentJson = JSON.stringify(current);
    const nextJson = JSON.stringify(merged);

    if (
      currentJson === nextJson &&
      row.activeKey === nextActiveKey &&
      row.deleteRequestedAt === deleteRequestedAt &&
      row.solvedAt === solvedAt &&
      row.completedAt === completedAt &&
      row.failedAt === failedAt
    ) {
      return;
    }

    await db
      .update(scenarioRuns)
      .set({
        state: merged.phase,
        stateRank: RUN_PHASE_ORDER[merged.phase],
        stateJson: nextJson,
        activeKey: nextActiveKey,
        deleteRequestedAt,
        solvedAt,
        completedAt,
        failedAt,
        updatedAt: now,
      })
      .where(eq(scenarioRuns.runId, runId));
  }

  private async syncRunStateForServerCall(
    callId: string,
    now: number,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const rows = await db
      .select()
      .from(hostRpcCalls)
      .where(eq(hostRpcCalls.callId, callId))
      .limit(1);
    const call = rows[0];
    if (
      !call ||
      call.direction !== "server_to_host" ||
      !call.runId ||
      !call.vmId
    ) {
      return;
    }

    if (call.method === "vm.launch") {
      await this.syncLaunchCallState(call);
      return;
    }

    if (call.method === "vm.destroy") {
      await this.syncDestroyCallState(call, now);
    }
  }

  private async syncLaunchCallState(call: PersistedHostRpcCall): Promise<void> {
    const lifecycle = describeLaunchCallLifecycle(call.status);
    if (!lifecycle || !call.runId || !call.vmId) {
      return;
    }

    const run = await this.loadRun(call.runId);
    if (!run) {
      return;
    }

    let changed = false;
    const nextState = {
      ...run.state,
      vms: run.state.vms.map((vm) => {
        if (vm.id !== call.vmId || !isLaunchPendingVmPhase(vm.phase)) {
          return vm;
        }
        if (
          vm.phase === lifecycle.phase &&
          vm.phaseDetail === lifecycle.detail
        ) {
          return vm;
        }
        changed = true;
        return {
          ...vm,
          phase: lifecycle.phase,
          phaseDetail: lifecycle.detail,
        };
      }),
    } satisfies RunStateDocument;

    if (!changed) {
      return;
    }

    await this.persistRunState(call.runId, nextState, {
      keepDeleteRequestedAt: true,
    });
  }

  private async syncDestroyCallState(
    call: PersistedHostRpcCall,
    now: number,
  ): Promise<void> {
    const vmDetail = describeDestroyCallVmDetail(call.status);
    if (!vmDetail || !call.runId || !call.vmId) {
      return;
    }

    const run = await this.loadRun(call.runId);
    if (!run) {
      return;
    }

    const runDetail =
      RUN_PHASE_ORDER[run.state.phase] >= RUN_PHASE_ORDER.tearing_down
        ? run.state.phaseDetail
        : await this.describeDestroyRunDetail(call.runId);

    let changed = false;
    const nextState = {
      ...run.state,
      phase:
        RUN_PHASE_ORDER[run.state.phase] >= RUN_PHASE_ORDER.tearing_down
          ? run.state.phase
          : "teardown_requested",
      phaseDetail: runDetail,
      vms: run.state.vms.map((vm) => {
        if (vm.id !== call.vmId || isDestroyTerminalVmPhase(vm.phase)) {
          return vm;
        }
        if (vm.phaseDetail === vmDetail) {
          return vm;
        }
        changed = true;
        return {
          ...vm,
          phaseDetail: vmDetail,
        };
      }),
    } satisfies RunStateDocument;

    if (
      !changed &&
      nextState.phase === run.state.phase &&
      nextState.phaseDetail === run.state.phaseDetail
    ) {
      return;
    }

    await this.persistRunState(call.runId, nextState, {
      deleteRequestedAt: run.deleteRequestedAt ?? now,
    });
  }

  private async describeDestroyRunDetail(runId: string): Promise<string> {
    const db = drizzle(this.env.DB);
    const rows = await db
      .select({ status: hostRpcCalls.status })
      .from(hostRpcCalls)
      .where(
        and(
          eq(hostRpcCalls.runId, runId),
          eq(hostRpcCalls.direction, "server_to_host"),
          eq(hostRpcCalls.method, "vm.destroy"),
          inArray(hostRpcCalls.status, [
            "queued",
            "sent",
            "request_acked",
            "running",
          ]),
        ),
      );
    const statuses = rows.map((row) => row.status);
    if (
      statuses.some(
        (status) => status === "request_acked" || status === "running",
      )
    ) {
      return "Host acknowledged teardown requests. Waiting for execution.";
    }
    if (statuses.some((status) => status === "sent")) {
      return "Teardown requests sent over the bridge. Waiting for host ack.";
    }
    return "Teardown requested. Waiting for host delivery.";
  }

  private async queueServerEnvelope(
    hostId: string,
    input: {
      callId: string | null;
      kind: RpcEnvelope["kind"];
      method: RpcEnvelope["method"];
      payload: Record<string, unknown>;
      expiresAt: number | null;
    },
  ): Promise<{ seq: number; messageId: string }> {
    const db = drizzle(this.env.DB);
    const host = await this.loadRequiredHost(hostId);
    const seq = host.serverNextSeq;
    const messageId = createAppId();
    const now = Date.now();

    await db.insert(hostRpcEnvelopes).values({
      id: createAppId(),
      hostId,
      direction: "server_to_host",
      seq,
      sessionId: host.activeSessionId,
      messageId,
      callId: input.callId,
      kind: input.kind,
      method: input.method,
      payloadJson: JSON.stringify(input.payload),
      occurredAt: now,
      appliedAt: null,
      ackedAt: null,
      expiresAt: input.expiresAt,
      createdAt: now,
    });

    await this.updateHostRow(hostId, {
      serverNextSeq: seq + 1,
      updatedAt: now,
    });

    return { seq, messageId };
  }

  private async scheduleNextAlarm(hostId: string): Promise<void> {
    const next = await this.computeNextAlarm(hostId);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  private async computeNextAlarm(hostId: string): Promise<number | null> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    const host = await this.loadRequiredHost(hostId);
    const [pendingEnvelope, pendingCall] = await Promise.all([
      db
        .select({ id: hostRpcEnvelopes.id })
        .from(hostRpcEnvelopes)
        .where(
          and(
            eq(hostRpcEnvelopes.hostId, hostId),
            eq(hostRpcEnvelopes.direction, "server_to_host"),
            isNull(hostRpcEnvelopes.ackedAt),
          ),
        )
        .limit(1),
      db
        .select({
          deadlineAt: hostRpcCalls.deadlineAt,
        })
        .from(hostRpcCalls)
        .where(
          and(
            eq(hostRpcCalls.hostId, hostId),
            inArray(hostRpcCalls.status, [
              "queued",
              "sent",
              "request_acked",
              "running",
            ]),
          ),
        )
        .orderBy(asc(hostRpcCalls.deadlineAt))
        .limit(1),
    ]);

    if (!pendingEnvelope.length && !pendingCall.length) {
      return null;
    }

    let next: number | null = null;
    if (pendingEnvelope.length) {
      next =
        now +
        (host.connected
          ? CONNECTED_RESEND_INTERVAL_MS
          : DISCONNECTED_RESEND_INTERVAL_MS);
    }
    const deadlineAt = pendingCall[0]?.deadlineAt ?? null;
    if (deadlineAt !== null) {
      next = next === null ? deadlineAt : Math.min(next, deadlineAt);
    }
    return next;
  }

  private async handleSocketClosed(ws: WebSocket): Promise<void> {
    const attachment = this.readSocketAttachment(ws);
    if (!attachment?.helloReceived || !attachment.sessionId) {
      return;
    }

    const host = await this.loadRequiredHost(attachment.hostId);
    if (host.activeSessionId !== attachment.sessionId) {
      return;
    }

    const replacement = this.ctx
      .getWebSockets(`host:${attachment.hostId}`)
      .map((socket) => ({
        socket,
        attachment: this.readSocketAttachment(socket),
      }))
      .filter(
        (
          candidate,
        ): candidate is { socket: WebSocket; attachment: SocketAttachment } =>
          candidate.attachment !== null &&
          candidate.socket !== ws &&
          candidate.attachment.hostId === attachment.hostId &&
          candidate.attachment.helloReceived &&
          candidate.socket.readyState === WebSocket.OPEN,
      )
      .sort(
        (left, right) =>
          right.attachment.connectedAt - left.attachment.connectedAt,
      )[0];

    const now = Date.now();
    await this.updateHostRow(attachment.hostId, {
      activeSessionId: replacement?.attachment.sessionId ?? null,
      connected: Boolean(replacement),
      disconnectedAt: replacement ? null : now,
      updatedAt: now,
    });

    await this.scheduleNextAlarm(attachment.hostId);
  }

  private async closeOlderSockets(
    hostId: string,
    current: WebSocket,
    sessionId: string,
  ): Promise<void> {
    for (const socket of this.ctx.getWebSockets(`host:${hostId}`)) {
      if (socket === current) {
        continue;
      }
      const attachment = this.readSocketAttachment(socket);
      if (!attachment || attachment.hostId !== hostId) {
        continue;
      }
      if (attachment.sessionId === sessionId) {
        continue;
      }
      try {
        socket.close(1012, "replaced by newer session");
      } catch {
        // ignore
      }
    }
  }

  private async findActiveSocket(
    hostId: string,
  ): Promise<{ socket: WebSocket; attachment: SocketAttachment } | null> {
    const host = await this.loadRequiredHost(hostId);
    const matches = this.ctx
      .getWebSockets(`host:${hostId}`)
      .map((socket) => ({
        socket,
        attachment: this.readSocketAttachment(socket),
      }))
      .filter(
        (
          candidate,
        ): candidate is { socket: WebSocket; attachment: SocketAttachment } =>
          candidate.attachment !== null &&
          candidate.attachment.hostId === hostId &&
          candidate.attachment.helloReceived &&
          candidate.socket.readyState === WebSocket.OPEN,
      )
      .sort(
        (left, right) =>
          right.attachment.connectedAt - left.attachment.connectedAt,
      );

    if (!matches.length) {
      return null;
    }

    const active =
      matches.find(
        (candidate) => candidate.attachment.sessionId === host.activeSessionId,
      ) ??
      matches[0] ??
      null;
    return active;
  }

  private readSocketAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      const parsed = ws.deserializeAttachment() as SocketAttachment | null;
      if (!parsed || typeof parsed.hostId !== "string") {
        return null;
      }
      return {
        hostId: parsed.hostId,
        sessionId:
          typeof parsed.sessionId === "string" && parsed.sessionId
            ? parsed.sessionId
            : null,
        connectedAt:
          typeof parsed.connectedAt === "number" &&
          Number.isFinite(parsed.connectedAt)
            ? Math.floor(parsed.connectedAt)
            : 0,
        helloReceived: Boolean(parsed.helloReceived),
      };
    } catch {
      return null;
    }
  }

  private async loadKnownHostId(): Promise<string | null> {
    const value = await this.ctx.storage.get<string>("hostId");
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private async persistKnownHostId(hostId: string): Promise<void> {
    await this.ctx.storage.put("hostId", hostId);
  }

  private async resolveKnownHostId(request: Request): Promise<string | null> {
    const header = request.headers.get("x-agent-host-id")?.trim();
    if (header) {
      await this.persistKnownHostId(header);
      return header;
    }

    try {
      const body = (await request.json()) as { hostId?: unknown };
      if (typeof body.hostId === "string" && body.hostId.trim()) {
        const hostId = body.hostId.trim();
        await this.persistKnownHostId(hostId);
        return hostId;
      }
    } catch {
      // ignore
    }

    return this.loadKnownHostId();
  }

  private async loadRequiredHost(hostId: string) {
    const db = drizzle(this.env.DB);
    const rows = await db
      .select()
      .from(agentHosts)
      .where(eq(agentHosts.id, hostId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(`host not found: ${hostId}`);
    }
    return row;
  }

  private async updateHostRow(
    hostId: string,
    values: Partial<typeof agentHosts.$inferInsert>,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    await db.update(agentHosts).set(values).where(eq(agentHosts.id, hostId));
  }

  private async resetHostToServerTransport(
    hostId: string,
    now: number,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    await db.delete(hostRpcReceipts).where(eq(hostRpcReceipts.hostId, hostId));
    await db
      .delete(hostRpcEnvelopes)
      .where(
        and(
          eq(hostRpcEnvelopes.hostId, hostId),
          eq(hostRpcEnvelopes.direction, "host_to_server"),
        ),
      );
    await db
      .delete(hostRpcCalls)
      .where(
        and(
          eq(hostRpcCalls.hostId, hostId),
          eq(hostRpcCalls.direction, "host_to_server"),
        ),
      );
    await this.updateHostRow(hostId, {
      hostNextSeq: 1,
      hostAckedSeq: 0,
      updatedAt: now,
    });
  }

  private async resetServerToHostTransport(
    hostId: string,
    now: number,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const affectedCalls = await db
      .select({ callId: hostRpcCalls.callId })
      .from(hostRpcCalls)
      .where(
        and(
          eq(hostRpcCalls.hostId, hostId),
          eq(hostRpcCalls.direction, "server_to_host"),
          inArray(hostRpcCalls.status, ["sent", "request_acked", "running"]),
        ),
      );
    await db
      .delete(hostRpcEnvelopes)
      .where(
        and(
          eq(hostRpcEnvelopes.hostId, hostId),
          eq(hostRpcEnvelopes.direction, "server_to_host"),
        ),
      );
    await db
      .update(hostRpcCalls)
      .set({
        status: "queued",
        requestMessageId: null,
        responseMessageId: null,
        requestAckedAt: null,
        responseAckedAt: null,
        startedAt: null,
        finishedAt: null,
        responseJson: null,
        errorJson: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(hostRpcCalls.hostId, hostId),
          eq(hostRpcCalls.direction, "server_to_host"),
          inArray(hostRpcCalls.status, ["sent", "request_acked", "running"]),
        ),
      );
    await this.updateHostRow(hostId, {
      serverNextSeq: 1,
      serverAckedSeq: 0,
      updatedAt: now,
    });

    for (const call of affectedCalls) {
      await this.syncRunStateForServerCall(call.callId, now);
    }
  }

  private async loadRun(runId: string): Promise<{
    runId: string;
    hostId: string;
    activeKey: string | null;
    deleteRequestedAt: number | null;
    solvedAt: number | null;
    completedAt: number | null;
    failedAt: number | null;
    state: RunStateDocument;
  } | null> {
    const db = drizzle(this.env.DB);
    const rows = await db
      .select({
        runId: scenarioRuns.runId,
        hostId: scenarioRuns.hostId,
        activeKey: scenarioRuns.activeKey,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
        solvedAt: scenarioRuns.solvedAt,
        completedAt: scenarioRuns.completedAt,
        failedAt: scenarioRuns.failedAt,
        stateJson: scenarioRuns.stateJson,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      runId: row.runId,
      hostId: row.hostId,
      activeKey: row.activeKey,
      deleteRequestedAt: row.deleteRequestedAt,
      solvedAt: row.solvedAt,
      completedAt: row.completedAt,
      failedAt: row.failedAt,
      state: parseRunState(row.stateJson),
    };
  }

  private async listOpenRunsForHost(hostId: string): Promise<
    Array<{
      runId: string;
      userId: string;
      state: RunStateDocument;
      deleteRequestedAt: number | null;
    }>
  > {
    const db = drizzle(this.env.DB);
    const rows = await db
      .select({
        runId: scenarioRuns.runId,
        userId: scenarioRuns.userId,
        stateJson: scenarioRuns.stateJson,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      })
      .from(scenarioRuns)
      .where(
        and(
          eq(scenarioRuns.hostId, hostId),
          isNull(scenarioRuns.completedAt),
          isNull(scenarioRuns.failedAt),
        ),
      )
      .orderBy(desc(scenarioRuns.updatedAt));

    return rows.map((row) => ({
      runId: row.runId,
      userId: row.userId,
      state: parseRunState(row.stateJson),
      deleteRequestedAt: row.deleteRequestedAt,
    }));
  }

  private async applyTerminalStateEvent(
    hostId: string,
    payload: TerminalStatePayload,
  ): Promise<void> {
    const host = await this.loadRequiredHost(hostId);
    const fallbackHost = extractTerminalHostFallback(host.hostInfoJson);
    const nextTerminalState = normalizeTerminalStatePayload(
      payload,
      fallbackHost,
    );
    if (!nextTerminalState) {
      return;
    }

    const run = await this.loadRun(nextTerminalState.runId);
    if (!run || run.hostId !== hostId) {
      return;
    }

    let matchedVm = false;
    const nextState = {
      ...run.state,
      vms: run.state.vms.map((candidate) => {
        if (candidate.runtimeVmName !== nextTerminalState.vmName) {
          return candidate;
        }

        matchedVm = true;
        let nextVm = {
          ...candidate,
          terminalPhase: nextTerminalState.state,
          terminalReason: nextTerminalState.reason,
          terminalObservedAt: nextTerminalState.observedAt,
          terminalTarget: nextTerminalState.terminalTarget
            ? {
                host: nextTerminalState.terminalTarget.host ?? null,
                port:
                  nextTerminalState.terminalTarget.port ??
                  candidate.terminalTarget.port,
                username:
                  nextTerminalState.terminalTarget.username ??
                  candidate.terminalTarget.username,
                checkedAt:
                  nextTerminalState.terminalTarget.checkedAt ??
                  nextTerminalState.observedAt,
              }
            : {
                host: null,
                port: candidate.terminalTarget.port,
                username: candidate.terminalTarget.username,
                checkedAt: nextTerminalState.observedAt,
              },
        } satisfies RunVmStateDocument;

        if (
          nextTerminalState.state === "pending" &&
          nextTerminalState.reason === "destroying" &&
          canAdvanceVmPhase(nextVm.phase, "destroying")
        ) {
          nextVm = {
            ...nextVm,
            phase: "destroying",
            phaseDetail: "Shell target cleared. Waiting for teardown.",
          };
        } else if (
          nextTerminalState.state === "failed" &&
          canAdvanceVmPhase(nextVm.phase, "failed")
        ) {
          nextVm = {
            ...nextVm,
            phase: "failed",
            phaseDetail:
              nextTerminalState.reason ??
              nextVm.phaseDetail ??
              "Shell target failed.",
          };
        }

        const decorated = decorateVmState(nextVm);
        if (nextTerminalState.state === "failed") {
          return decorated;
        }
        return applyProbePhaseHeuristics(decorated);
      }),
    } satisfies RunStateDocument;

    if (!matchedVm) {
      return;
    }

    await this.persistRunState(nextTerminalState.runId, nextState, {
      keepDeleteRequestedAt: true,
    });
  }

  private async queueMissingTerminalStateRefreshes(
    hostId: string,
  ): Promise<void> {
    const runs = await this.listOpenRunsForHost(hostId);
    for (const run of runs) {
      for (const vm of run.state.vms) {
        await this.queueTerminalStateGetIfNeeded(hostId, run.runId, vm.id, vm);
      }
    }
  }

  private async queueTerminalStateGetIfNeeded(
    hostId: string,
    runId: string,
    vmId: string,
    vm: RunVmStateDocument | null,
    options?: {
      requireBootPassing?: boolean;
    },
  ): Promise<void> {
    if (
      !vm ||
      !shouldQueueTerminalStateGet(vm, options?.requireBootPassing ?? false)
    ) {
      return;
    }

    const db = drizzle(this.env.DB);
    const existing = await db
      .select({ callId: hostRpcCalls.callId })
      .from(hostRpcCalls)
      .where(
        and(
          eq(hostRpcCalls.hostId, hostId),
          eq(hostRpcCalls.direction, "server_to_host"),
          eq(hostRpcCalls.method, "vm.terminal.get"),
          eq(hostRpcCalls.runId, runId),
          eq(hostRpcCalls.vmId, vmId),
          inArray(hostRpcCalls.status, [
            "queued",
            "sent",
            "request_acked",
            "running",
          ]),
        ),
      )
      .limit(1);
    if (existing.length) {
      return;
    }

    const now = Date.now();
    const deadlineAt = now + 10_000;
    const expiresAt = deadlineAt + 7 * 24 * 60 * 60 * 1000;
    await db.insert(hostRpcCalls).values({
      callId: createAppId(),
      hostId,
      userId: null,
      runId,
      vmId,
      direction: "server_to_host",
      method: "vm.terminal.get",
      status: "queued",
      idempotencyKey: null,
      requestMessageId: null,
      responseMessageId: null,
      requestJson: JSON.stringify({
        runId,
        vmName: vm.runtimeVmName,
      }),
      responseJson: null,
      errorJson: null,
      requestAckedAt: null,
      responseAckedAt: null,
      startedAt: null,
      finishedAt: null,
      deadlineAt,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function clampAck(
  nextSeq: number,
  currentAck: number,
  requestedAck: number,
): number {
  return Math.max(currentAck, Math.min(requestedAck, Math.max(0, nextSeq - 1)));
}

function normalizeTransportId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shouldResumeTransportLane(
  currentTransportId: string | null,
  requestedTransportId: string | null,
  nextSeq: number,
  currentAck: number,
  requestedAck: number,
): boolean {
  if (
    currentTransportId &&
    requestedTransportId &&
    currentTransportId === requestedTransportId
  ) {
    if (!hasTransportState(nextSeq, currentAck) && requestedAck > 0) {
      return false;
    }
    return true;
  }
  return false;
}

function hasTransportState(nextSeq: number, ackedSeq: number): boolean {
  return nextSeq > 1 || ackedSeq > 0;
}

function planInboundBatch(
  currentAck: number,
  firstSeq: number,
  lastSeq: number,
  envelopeCount: number,
): InboundBatchPlan {
  if (envelopeCount === 0 || firstSeq <= 0 || lastSeq < firstSeq) {
    return { kind: "gap" };
  }
  const expectedLength = lastSeq - firstSeq + 1;
  if (expectedLength !== envelopeCount) {
    return { kind: "gap" };
  }
  if (lastSeq <= currentAck) {
    return { kind: "ack_only" };
  }
  if (firstSeq > currentAck + 1) {
    return { kind: "gap" };
  }
  return {
    kind: "process",
    startIndex: Math.max(0, currentAck + 1 - firstSeq),
  };
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function resolveCallStatus(payload: Record<string, unknown>): string {
  const status = payload.status;
  if (
    status === "queued" ||
    status === "sent" ||
    status === "request_acked" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out"
  ) {
    return status;
  }
  return payload.error ? "failed" : "succeeded";
}

function resolveCallResponse(payload: Record<string, unknown>): unknown {
  if ("result" in payload) {
    return payload.result;
  }
  if ("response" in payload) {
    return payload.response;
  }
  return payload;
}

function resolveCallError(payload: Record<string, unknown>): unknown {
  return "error" in payload ? payload.error : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNestedNumber(value: unknown, key: string): number | null {
  return isRecord(value) ? readNumber(value[key]) : null;
}

function stringifyUnknown(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (isRecord(value)) {
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function describeLaunchCallLifecycle(
  status: string,
): { phase: VmPhase; detail: string } | null {
  switch (status) {
    case "queued":
      return {
        phase: "queued",
        detail: "Waiting for host delivery.",
      };
    case "sent":
      return {
        phase: "launching",
        detail: "Launch request sent over the bridge. Waiting for host ack.",
      };
    case "request_acked":
    case "running":
      return {
        phase: "launching",
        detail: "Host acknowledged launch request. Waiting for execution.",
      };
    default:
      return null;
  }
}

function describeDestroyCallVmDetail(status: string): string | null {
  switch (status) {
    case "queued":
      return "Teardown requested. Waiting for host delivery.";
    case "sent":
      return "Teardown request sent over the bridge. Waiting for host ack.";
    case "request_acked":
    case "running":
      return "Host acknowledged teardown request. Waiting for execution.";
    default:
      return null;
  }
}

function isLaunchPendingVmPhase(phase: VmPhase): boolean {
  return phase === "queued" || phase === "launching";
}

function isDestroyTerminalVmPhase(phase: VmPhase): boolean {
  return (
    phase === "destroying" ||
    phase === "archived" ||
    phase === "completed" ||
    phase === "failed"
  );
}

function matchesInventoryVm(
  value: unknown,
  runId: string,
  runtimeVmName: string,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const candidateRunId =
    typeof value.run_id === "string"
      ? value.run_id
      : typeof value.runId === "string"
        ? value.runId
        : null;
  const candidateName =
    typeof value.name === "string"
      ? value.name
      : typeof value.vm_name === "string"
        ? value.vm_name
        : null;
  return candidateRunId === runId || candidateName === runtimeVmName;
}

function extractTerminalTarget(
  value: unknown,
  fallbackHost?: string | null,
): Partial<RunVmStateDocument["terminalTarget"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasNestedTarget =
    isRecord(value.terminal_target) || isRecord(value.terminalTarget);
  const source: Record<string, unknown> = hasNestedTarget
    ? isRecord(value.terminal_target)
      ? value.terminal_target
      : (value.terminalTarget as Record<string, unknown>)
    : value;
  const hasExplicitTargetFields =
    hasNestedTarget ||
    typeof source.host === "string" ||
    typeof source.port === "number" ||
    typeof source.peerHost === "string" ||
    typeof source.peer_host === "string";

  const host =
    typeof source.peerHost === "string"
      ? source.peerHost
      : typeof source.host === "string"
        ? source.host
        : typeof source.peer_host === "string"
          ? source.peer_host
          : typeof fallbackHost === "string" && fallbackHost.trim()
            ? fallbackHost.trim()
            : null;
  const port = readNumber(source.port) ?? 22;
  const username =
    typeof source.username === "string" && source.username.trim()
      ? source.username.trim()
      : "ubuntu";
  const checkedAt =
    readNumber(source.checkedAt) ?? readNumber(source.checked_at) ?? Date.now();

  if (!hasExplicitTargetFields || !host || port <= 0) {
    return null;
  }

  return {
    host,
    port,
    username,
    checkedAt,
  };
}

function normalizeTerminalStatePayload(
  value: unknown,
  fallbackHost?: string | null,
): {
  runId: string;
  vmName: string;
  state: RunVmStateDocument["terminalPhase"];
  terminalTarget: Partial<RunVmStateDocument["terminalTarget"]> | null;
  reason: string | null;
  observedAt: number;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId =
    typeof value.runId === "string"
      ? value.runId.trim()
      : typeof value.run_id === "string"
        ? value.run_id.trim()
        : "";
  const vmName =
    typeof value.vmName === "string"
      ? value.vmName.trim()
      : typeof value.vm_name === "string"
        ? value.vm_name.trim()
        : "";
  const state =
    value.state === "pending" ||
    value.state === "ready" ||
    value.state === "failed"
      ? value.state
      : null;
  const observedAt =
    readNumber(value.observedAt) ?? readNumber(value.observed_at) ?? Date.now();
  const reason =
    typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : null;
  if (!runId || !vmName || state === null) {
    return null;
  }

  const terminalTarget = extractTerminalTarget(value, fallbackHost);
  if (state === "ready" && !terminalTarget) {
    return null;
  }

  return {
    runId,
    vmName,
    state,
    terminalTarget: state === "ready" ? terminalTarget : null,
    reason,
    observedAt,
  };
}

function inferVmPhaseFromInventory(
  value: Record<string, unknown>,
  vm: RunVmStateDocument,
): VmPhase | null {
  const state =
    typeof value.state === "string"
      ? value.state.toLowerCase()
      : typeof value.status === "string"
        ? value.status.toLowerCase()
        : "";

  if (state.includes("failed") || state.includes("error")) {
    return "failed";
  }
  if (state.includes("destroy")) {
    return "destroying";
  }
  if (state.includes("ready") || state.includes("running")) {
    return vm.bootProbes.length ? "booting" : "ready";
  }
  if (state.includes("boot")) {
    return "booting";
  }
  if (state.includes("launch") || state.includes("create")) {
    return "launching";
  }
  return null;
}

function advanceRunPhase(current: RunPhase, next: RunPhase): RunPhase {
  return canAdvanceRunPhase(current, next) ? next : current;
}

function extractTerminalHostFallback(
  hostInfoJson: string | null,
): string | null {
  if (!hostInfoJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(hostInfoJson) as Record<string, unknown>;
    const primaryIpv4 =
      typeof parsed.primaryIpv4 === "string" ? parsed.primaryIpv4.trim() : "";
    if (primaryIpv4) {
      return primaryIpv4;
    }
    const primaryIpv6 =
      typeof parsed.primaryIpv6 === "string" ? parsed.primaryIpv6.trim() : "";
    return primaryIpv6 || null;
  } catch {
    return null;
  }
}
