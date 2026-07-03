import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  parseBridgeMessageV5,
  serializeBridgeMessageV5,
} from "@/control-plane/bridge-v5";
import {
  agentHosts,
  hostActualState,
  scenarioRuns,
} from "@/db/schema";
import { createAppId } from "@/lib/id";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  canAdvanceRunPhase,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import {
  applyHostReportToRunState,
  applyVmReportToRunState,
} from "@/lib/run-lifecycle";
import { nextSolvedAt } from "@/lib/scenario-run-outcome";
import {
  loadOrCreateHostDesiredState,
  mutateStoredHostDesiredState,
} from "@/lib/desired-state-store";
import { removeDesiredBuild } from "@/lib/desired-state";
import {
  maintainHostBuildAssignments,
  recordHostBuildReports,
} from "@/lib/build-scheduler";
import {
  isReportedHostRoleAllowed,
  resolveScenarioEnabledForHostRole,
} from "@/lib/scenario-hosts";
import type { BridgeMessageV5, HostDesiredStateV1 } from "@/generated/bridge";

const HOST_BUILD_MAINTENANCE_INTERVAL_MS = 60_000;

interface SocketAttachment {
  hostId: string;
  sessionId: string | null;
  connectedAt: number;
  helloReceived: boolean;
  bridgeProtocol: "v5" | null;
  lastDesiredVersionSent: number | null;
}

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

    const bridgeMessage = parseBridgeMessageV5(message);
    if (bridgeMessage) {
      await this.handleBridgeMessageV5(ws, attachment, bridgeMessage);
      return;
    }

    try {
      ws.close(1003, "invalid bridge v5 message");
    } catch {
      // ignore
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
      bridgeProtocol: null,
      lastDesiredVersionSent: null,
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

  private async handleBridgeMessageV5(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: BridgeMessageV5,
  ): Promise<void> {
    if (message.type === "client_hello") {
      await this.handleBridgeClientHello(ws, attachment, message);
      return;
    }

    if (
      attachment.bridgeProtocol !== "v5" ||
      !attachment.helloReceived ||
      !attachment.sessionId
    ) {
      try {
        ws.close(1008, "client hello required");
      } catch {
        // ignore
      }
      return;
    }

    if (message.host_id !== attachment.hostId) {
      try {
        ws.close(1008, "host mismatch");
      } catch {
        // ignore
      }
      return;
    }

    const host = await this.loadRequiredHost(attachment.hostId);
    if (host.activeSessionId !== attachment.sessionId) {
      return;
    }

    if (message.type === "state_report") {
      await this.applyBridgeStateReport(message.host_id, message.report);
    } else if (message.type === "vm_report") {
      await this.applyBridgeVmReport(message.host_id, message.report);
    } else if (message.type === "build_report") {
      await this.applyBridgeBuildReport(message.host_id, message.report);
    } else if (message.type === "sync_request") {
      await this.sendBridgeDesiredState(ws, attachment, message.host_id);
    } else {
      try {
        ws.close(1003, "server message type");
      } catch {
        // ignore
      }
      return;
    }

    await this.reconcileHost(message.host_id);
  }

  private async handleBridgeClientHello(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<BridgeMessageV5, { type: "client_hello" }>,
  ): Promise<void> {
    if (message.host_id !== attachment.hostId) {
      try {
        ws.close(1008, "host mismatch");
      } catch {
        // ignore
      }
      return;
    }

    const now = Date.now();
    const host = await this.loadRequiredHost(message.host_id);
    if (!isReportedHostRoleAllowed(message.role, host.role)) {
      try {
        ws.close(1008, "host role mismatch");
      } catch {
        // ignore
      }
      return;
    }

    const db = drizzle(this.env.DB);
    const desiredState = await loadOrCreateHostDesiredState(
      db,
      message.host_id,
      now,
    );
    const sessionId = `v5:${createAppId()}`;
    const nextAttachment: SocketAttachment = {
      ...attachment,
      sessionId,
      helloReceived: true,
      bridgeProtocol: "v5",
      lastDesiredVersionSent:
        message.last_applied_desired_version === desiredState.version
          ? desiredState.version
          : null,
    };
    ws.serializeAttachment(nextAttachment);

    await this.persistKnownHostId(message.host_id);
    await this.updateHostRow(message.host_id, {
      activeSessionId: sessionId,
      scenarioEnabled: resolveScenarioEnabledForHostRole(
        host.role,
        host.scenarioEnabled,
      ),
      connected: true,
      connectedAt: host.connectedAt ?? now,
      disconnectedAt: null,
      lastClientHelloAt: now,
      lastServerHelloAt: now,
      agentVersion: message.agent_version,
      updatedAt: now,
    });

    await this.closeOlderSockets(message.host_id, ws, sessionId);

    ws.send(
      serializeBridgeMessageV5({
        type: "server_hello",
        protocol_version: message.protocol_version,
        host_id: message.host_id,
        desired_version: desiredState.version,
      }),
    );

    if (message.last_applied_desired_version !== desiredState.version) {
      await this.sendBridgeDesiredState(
        ws,
        nextAttachment,
        message.host_id,
        desiredState,
      );
    }

    await this.reconcileHost(message.host_id);
  }

  private async sendBridgeDesiredState(
    ws: WebSocket,
    attachment: SocketAttachment,
    hostId: string,
    desiredState?: HostDesiredStateV1,
  ): Promise<void> {
    const state =
      desiredState ??
      (await loadOrCreateHostDesiredState(
        drizzle(this.env.DB),
        hostId,
        Date.now(),
      ));
    ws.send(
      serializeBridgeMessageV5({
        type: "desired_state",
        protocol_version: 5,
        host_id: hostId,
        desired_state: state,
      }),
    );
    ws.serializeAttachment({
      ...attachment,
      lastDesiredVersionSent: state.version,
    });
  }

  private async applyBridgeStateReport(
    hostId: string,
    report: Extract<BridgeMessageV5, { type: "state_report" }>["report"],
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    await db
      .insert(hostActualState)
      .values({
        hostId,
        appliedDesiredVersion: report.applied_desired_version,
        observedAt: report.observed_at_unix_ms,
        reportJson: report,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: hostActualState.hostId,
        set: {
          appliedDesiredVersion: report.applied_desired_version,
          observedAt: report.observed_at_unix_ms,
          reportJson: report,
          updatedAt: now,
        },
      });

    await this.updateHostRow(hostId, {
      connected: true,
      disconnectedAt: null,
      lastHeartbeatAt: now,
      lastInventoryAt: now,
      updatedAt: now,
    });

    const buildUpdates = await recordHostBuildReports(
      db,
      hostId,
      report.builds,
      now,
    );
    await this.removeTerminalBuildsFromDesiredState(
      hostId,
      buildUpdates.terminalBuildIds,
      now,
    );

    const runs = await this.listOpenRunsForHost(hostId);
    for (const run of runs) {
      await this.persistRunState(
        run.runId,
        applyHostReportToRunState({
          runId: run.runId,
          current: run.state,
          report,
        }),
        { keepDeleteRequestedAt: true },
      );
    }
  }

  private async applyBridgeVmReport(
    hostId: string,
    report: Extract<BridgeMessageV5, { type: "vm_report" }>["report"],
  ): Promise<void> {
    const run = await this.loadRun(report.run_id);
    if (!run || run.hostId !== hostId) {
      return;
    }

    const now = Date.now();
    await this.updateHostRow(hostId, {
      connected: true,
      disconnectedAt: null,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    await this.persistRunState(
      report.run_id,
      applyVmReportToRunState({
        runId: report.run_id,
        current: run.state,
        report,
      }),
      { keepDeleteRequestedAt: true },
    );
  }

  private async applyBridgeBuildReport(
    hostId: string,
    report: Extract<BridgeMessageV5, { type: "build_report" }>["report"],
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    await this.updateHostRow(hostId, {
      connected: true,
      disconnectedAt: null,
      lastHeartbeatAt: now,
      updatedAt: now,
    });
    const buildUpdates = await recordHostBuildReports(db, hostId, [report], now);
    await this.removeTerminalBuildsFromDesiredState(
      hostId,
      buildUpdates.terminalBuildIds,
      now,
    );
  }

  private async reconcileHost(hostId: string): Promise<void> {
    await maintainHostBuildAssignments(drizzle(this.env.DB), hostId, Date.now());

    const activeSocket = await this.findActiveSocket(hostId);
    if (activeSocket?.attachment.bridgeProtocol === "v5") {
      await this.dispatchBridgeDesiredStateIfNeeded(
        hostId,
        activeSocket.socket,
        activeSocket.attachment,
      );
    }

    await this.scheduleNextAlarm(hostId);
  }

  private async dispatchBridgeDesiredStateIfNeeded(
    hostId: string,
    ws: WebSocket,
    attachment: SocketAttachment,
  ): Promise<void> {
    if (
      attachment.bridgeProtocol !== "v5" ||
      !attachment.sessionId ||
      attachment.hostId !== hostId
    ) {
      return;
    }

    const host = await this.loadRequiredHost(hostId);
    if (host.activeSessionId !== attachment.sessionId) {
      return;
    }

    const desiredState = await loadOrCreateHostDesiredState(
      drizzle(this.env.DB),
      hostId,
      Date.now(),
    );
    if (attachment.lastDesiredVersionSent === desiredState.version) {
      return;
    }

    await this.sendBridgeDesiredState(ws, attachment, hostId, desiredState);
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

  private async removeTerminalBuildsFromDesiredState(
    hostId: string,
    buildIds: string[],
    nowUnixMs: number,
  ): Promise<void> {
    if (!buildIds.length) {
      return;
    }

    await mutateStoredHostDesiredState(
      drizzle(this.env.DB),
      hostId,
      nowUnixMs,
      (draft) => {
        for (const buildId of buildIds) {
          removeDesiredBuild(draft, { buildId });
        }
      },
    );
  }

  private async scheduleNextAlarm(hostId: string): Promise<void> {
    const next = await this.computeNextAlarm(hostId);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  private async computeNextAlarm(_hostId: string): Promise<number | null> {
    return Date.now() + HOST_BUILD_MAINTENANCE_INTERVAL_MS;
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
        bridgeProtocol: parsed.bridgeProtocol === "v5" ? "v5" : null,
        lastDesiredVersionSent:
          typeof parsed.lastDesiredVersionSent === "number" &&
          Number.isFinite(parsed.lastDesiredVersionSent) &&
          parsed.lastDesiredVersionSent >= 0
            ? Math.floor(parsed.lastDesiredVersionSent)
            : null,
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

}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}
