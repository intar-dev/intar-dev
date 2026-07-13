import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  parseBridgeMessageV6,
  serializeBridgeMessageV6,
} from "@/control-plane/bridge-v6";
import {
  agentHosts,
  hostActualState,
  scenarioRuns,
} from "@/db/schema";
import {
  commitHostCpuReservation,
  nextPendingHostCpuReservationExpiry,
  reconcileHostCpuReservations,
  reserveHostCpuInD1,
  rollbackPendingHostCpuReservation,
} from "@/control-plane/host-cpu-reservations";
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
import { recordProbeTransitions } from "@/lib/run-probe-history";
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
import { expireOverdueRunLeases } from "@/lib/scenario-runs";
import {
  isReportedHostRoleAllowed,
  resolveScenarioEnabledForHostRole,
} from "@/lib/scenario-hosts";
import type { BridgeMessageV6, HostDesiredStateV2 } from "@/generated/bridge";

const HOST_BUILD_MAINTENANCE_INTERVAL_MS = 60_000;
const DESIRED_VERSION_LAG_REPUSH_AFTER_MS = 10_000;

interface SocketAttachment {
  hostId: string;
  sessionId: string | null;
  connectedAt: number;
  helloReceived: boolean;
  bridgeProtocol: "v6" | null;
  lastDesiredVersionSent: number | null;
  lastDesiredDispatchAtMs: number | null;
}

export class HostRuntimeDO extends DurableObject<Cloudflare.Env> {
  private cpuReservationQueue: Promise<void> = Promise.resolve();

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

    if (url.pathname === "/_internal/retire") {
      return this.handleRetire(request);
    }

    if (url.pathname.startsWith("/_internal/cpu-reservations/")) {
      return this.handleCpuReservationRequest(request, url.pathname);
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

    const bridgeMessage = parseBridgeMessageV6(message);
    if (bridgeMessage) {
      await this.handleBridgeMessageV6(ws, attachment, bridgeMessage);
      return;
    }

    try {
      ws.close(1003, "invalid bridge v6 message");
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
      lastDesiredDispatchAtMs: null,
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

  private async handleRetire(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    const hostId =
      request.headers.get("x-agent-host-id")?.trim() ??
      (await this.loadKnownHostId()) ??
      "";
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1001, "host retired");
      } catch {
        // The socket may already be closing; retirement remains idempotent.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return jsonResponse({ ok: true, hostId });
  }

  private async handleCpuReservationRequest(
    request: Request,
    pathname: string,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    const input = await parseCpuReservationRequest(request);
    if (!input) {
      return jsonResponse({ error: "invalid CPU reservation request" }, 400);
    }
    const knownHostId = await this.loadKnownHostId();
    if (knownHostId && knownHostId !== input.hostId) {
      return jsonResponse({ error: "host id does not match durable object" }, 409);
    }
    try {
      await this.loadRequiredHost(input.hostId);
    } catch {
      return jsonResponse({ error: "host not found" }, 404);
    }
    await this.persistKnownHostId(input.hostId);

    return this.withCpuReservationLock(async () => {
      const db = drizzle(this.env.DB);
      const now = Date.now();
      if (pathname.endsWith("/reserve")) {
        if (input.cpuMillis === null) {
          return jsonResponse({ error: "cpuMillis is required" }, 400);
        }
        const result = await reserveHostCpuInD1(db, {
          hostId: input.hostId,
          runId: input.runId,
          cpuMillis: input.cpuMillis,
          nowUnixMs: now,
        });
        await this.scheduleNextAlarm(input.hostId);
        return jsonResponse(result, result.ok ? 201 : 409);
      }
      if (pathname.endsWith("/commit")) {
        const ok = await commitHostCpuReservation(db, {
          hostId: input.hostId,
          runId: input.runId,
          nowUnixMs: now,
        });
        await this.scheduleNextAlarm(input.hostId);
        return jsonResponse({ ok });
      }
      if (pathname.endsWith("/rollback")) {
        const rolledBack = await rollbackPendingHostCpuReservation(db, input);
        await this.scheduleNextAlarm(input.hostId);
        return jsonResponse({ ok: true, rolledBack });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
  }

  private async withCpuReservationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.cpuReservationQueue;
    let release!: () => void;
    this.cpuReservationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async handleBridgeMessageV6(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: BridgeMessageV6,
  ): Promise<void> {
    if (message.type === "client_hello") {
      await this.handleBridgeClientHello(ws, attachment, message);
      return;
    }

    if (
      attachment.bridgeProtocol !== "v6" ||
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
    message: Extract<BridgeMessageV6, { type: "client_hello" }>,
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
    const sessionId = `v6:${createAppId()}`;
    const nextAttachment: SocketAttachment = {
      ...attachment,
      sessionId,
      helloReceived: true,
      bridgeProtocol: "v6",
      lastDesiredVersionSent:
        message.last_applied_desired_version === desiredState.version
          ? desiredState.version
          : null,
      lastDesiredDispatchAtMs: null,
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
      serializeBridgeMessageV6({
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
    desiredState?: HostDesiredStateV2,
  ): Promise<void> {
    const state =
      desiredState ??
      (await loadOrCreateHostDesiredState(
        drizzle(this.env.DB),
        hostId,
        Date.now(),
      ));
    ws.send(
      serializeBridgeMessageV6({
        type: "desired_state",
        protocol_version: 6,
        host_id: hostId,
        desired_state: state,
      }),
    );
    ws.serializeAttachment({
      ...attachment,
      lastDesiredVersionSent: state.version,
      lastDesiredDispatchAtMs: Date.now(),
    });
  }

  private async applyBridgeStateReport(
    hostId: string,
    report: Extract<BridgeMessageV6, { type: "state_report" }>["report"],
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
    await this.withCpuReservationLock(() =>
      reconcileHostCpuReservations(db, hostId, now),
    );
  }

  private async applyBridgeVmReport(
    hostId: string,
    report: Extract<BridgeMessageV6, { type: "vm_report" }>["report"],
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
    report: Extract<BridgeMessageV6, { type: "build_report" }>["report"],
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
    const now = Date.now();
    const db = drizzle(this.env.DB);
    await maintainHostBuildAssignments(db, hostId, now);
    await expireOverdueRunLeases(hostId, now, {
      db,
      wakeHostRuntime: false,
    });
    await this.withCpuReservationLock(() =>
      reconcileHostCpuReservations(db, hostId, now),
    );

    const activeSocket = await this.findActiveSocket(hostId);
    if (activeSocket?.attachment.bridgeProtocol === "v6") {
      const lag = await this.loadDesiredVersionLag(hostId, now);
      const shouldRepushLaggingVersion =
        lag.lagging &&
        (activeSocket.attachment.lastDesiredDispatchAtMs === null ||
          now - activeSocket.attachment.lastDesiredDispatchAtMs >
            DESIRED_VERSION_LAG_REPUSH_AFTER_MS);
      await this.dispatchBridgeDesiredStateIfNeeded(
        hostId,
        activeSocket.socket,
        activeSocket.attachment,
        { force: shouldRepushLaggingVersion },
      );
    }

    await this.scheduleNextAlarm(hostId);
  }

  private async dispatchBridgeDesiredStateIfNeeded(
    hostId: string,
    ws: WebSocket,
    attachment: SocketAttachment,
    options?: { force?: boolean },
  ): Promise<void> {
    if (
      attachment.bridgeProtocol !== "v6" ||
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
    if (!options?.force && attachment.lastDesiredVersionSent === desiredState.version) {
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

    await recordProbeTransitions(db, {
      runId,
      current,
      next: merged,
      observedAt: now,
    });
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

  private async computeNextAlarm(hostId: string): Promise<number | null> {
    const now = Date.now();
    const activeSocket = await this.findActiveSocket(hostId);
    const desiredState = await loadOrCreateHostDesiredState(
      drizzle(this.env.DB),
      hostId,
      now,
    );
    const lag = await this.loadDesiredVersionLag(hostId, now, desiredState);
    const undeliveredDesired = activeSocket
      ? activeSocket.attachment.lastDesiredVersionSent !== desiredState.version
      : false;
    const nextLeaseExpiry = desiredState.vms
      .filter((vm) => vm.desired_phase === "running")
      .map((vm) => vm.lease_expires_at_unix_ms)
      .sort((left, right) => left - right)[0];
    const nextReservationExpiry = await nextPendingHostCpuReservationExpiry(
      drizzle(this.env.DB),
      hostId,
    );

    if (
      !activeSocket &&
      !undeliveredDesired &&
      typeof nextLeaseExpiry !== "number" &&
      typeof nextReservationExpiry !== "number" &&
      desiredState.builds.length === 0
    ) {
      // A lagging applied version alone does not keep the alarm armed:
      // without a socket there is nothing to re-push to, and connect/wake
      // re-arm the alarm.
      return null;
    }

    const candidates = [now + HOST_BUILD_MAINTENANCE_INTERVAL_MS];
    if (typeof nextLeaseExpiry === "number") {
      // Overdue selection is strict (`expiry < now`), so aim one tick past
      // the expiry to avoid a no-op alarm fire exactly on the boundary.
      candidates.push(Math.max(now + 1, nextLeaseExpiry + 1));
    }
    if (typeof nextReservationExpiry === "number") {
      candidates.push(Math.max(now + 1, nextReservationExpiry + 1));
    }
    if (lag.lagging && activeSocket) {
      candidates.push(now + DESIRED_VERSION_LAG_REPUSH_AFTER_MS);
    }
    return Math.min(...candidates);
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
        bridgeProtocol: parsed.bridgeProtocol === "v6" ? "v6" : null,
        lastDesiredVersionSent:
          typeof parsed.lastDesiredVersionSent === "number" &&
          Number.isFinite(parsed.lastDesiredVersionSent) &&
          parsed.lastDesiredVersionSent >= 0
            ? Math.floor(parsed.lastDesiredVersionSent)
            : null,
        lastDesiredDispatchAtMs:
          typeof parsed.lastDesiredDispatchAtMs === "number" &&
          Number.isFinite(parsed.lastDesiredDispatchAtMs) &&
          parsed.lastDesiredDispatchAtMs >= 0
            ? Math.floor(parsed.lastDesiredDispatchAtMs)
            : null,
      };
    } catch {
      return null;
    }
  }

  private async loadDesiredVersionLag(
    hostId: string,
    nowUnixMs: number,
    desiredState?: HostDesiredStateV2,
  ): Promise<{ lagging: boolean; desiredVersion: number; appliedVersion: number | null }> {
    const db = drizzle(this.env.DB);
    const desired =
      desiredState ?? (await loadOrCreateHostDesiredState(db, hostId, nowUnixMs));
    const rows = await db
      .select({
        appliedDesiredVersion: hostActualState.appliedDesiredVersion,
      })
      .from(hostActualState)
      .where(eq(hostActualState.hostId, hostId))
      .limit(1);
    const appliedVersion = rows[0]?.appliedDesiredVersion ?? null;
    return {
      lagging: appliedVersion !== null && appliedVersion < desired.version,
      desiredVersion: desired.version,
      appliedVersion,
    };
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

async function parseCpuReservationRequest(request: Request): Promise<{
  hostId: string;
  runId: string;
  cpuMillis: number | null;
} | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
    const runId = typeof value.runId === "string" ? value.runId.trim() : "";
    const cpuMillis = value.cpuMillis;
    if (
      !hostId ||
      hostId.length > 128 ||
      !runId ||
      runId.length > 128 ||
      (cpuMillis !== undefined &&
        (typeof cpuMillis !== "number" ||
          !Number.isSafeInteger(cpuMillis) ||
          cpuMillis <= 0 ||
          cpuMillis > 4_294_967_295))
    ) {
      return null;
    }
    return {
      hostId,
      runId,
      cpuMillis: typeof cpuMillis === "number" ? cpuMillis : null,
    };
  } catch {
    return null;
  }
}
