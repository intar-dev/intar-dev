import {
  DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
  HostRuntimeBase,
  type RunProjectionOutcome,
  type SocketAttachment,
} from "./host-runtime-do/base";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  parseBridgeMessageV6,
  serializeBridgeMessageV6,
} from "@/control-plane/bridge-v6";
import { agentHosts, hostActualState } from "@/db/schema";
import {
  commitHostCpuReservation,
  reconcileHostCpuReservations,
  reserveHostCpuInD1,
  rollbackPendingHostCpuReservation,
} from "@/control-plane/host-cpu-reservations";
import { createAppId } from "@/lib/id";
import {
  applyHostReportToRunState,
  applyVmReportToRunState,
} from "@/lib/run-lifecycle";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";
import {
  maintainHostBuildAssignments,
  recordHostBuildReports,
} from "@/lib/build-scheduler";
import { expireOverdueRunLeases } from "@/lib/scenario-runs";
import {
  isReportedHostRoleAllowed,
  resolveScenarioEnabledForHostRole,
} from "@/lib/scenario-hosts";
import type {
  BridgeMessageV6,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";

export class HostRuntimeDO extends HostRuntimeBase {
  private cpuReservationQueue: Promise<void> = Promise.resolve();
  private desiredDispatchQueue: Promise<void> = Promise.resolve();

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

    // Do not make a connected agent wait for a separately scheduled event
    // before receiving a newly committed desired state. Arm the alarm in the
    // finally block so it remains the durable fallback even if dispatch fails.
    try {
      if (
        this.ctx
          .getWebSockets(`host:${hostId}`)
          .some((socket) => socket.readyState === WebSocket.OPEN)
      ) {
        const activeSocket = await this.findActiveSocket(hostId);
        if (activeSocket?.attachment.bridgeProtocol === "v6") {
          await this.dispatchBridgeDesiredStateIfNeeded(
            hostId,
            activeSocket.socket,
          );
        }
      }
    } finally {
      // Direct delivery owns the latency path. Keep a durable lag fallback,
      // but do not start D1 maintenance concurrently with a VM's first boot.
      await this.scheduleAlarmNoLaterThan(
        Date.now() + DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
      );
    }
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
    this.knownHostId = null;
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
      return jsonResponse(
        { error: "host id does not match durable object" },
        409,
      );
    }
    const commit = pathname.endsWith("/commit");
    if (!commit) {
      try {
        await this.loadRequiredHost(input.hostId);
      } catch {
        return jsonResponse({ error: "host not found" }, 404);
      }
    }
    await this.persistKnownHostId(input.hostId);

    return this.withCpuReservationLock(async () => {
      const db = drizzle(this.env.DB);
      const now = Date.now();
      if (pathname.endsWith("/reserve")) {
        if (input.steadyCpuMillisByVm === null) {
          return jsonResponse(
            { error: "steadyCpuMillisByVm is required" },
            400,
          );
        }
        const result = await reserveHostCpuInD1(db, {
          hostId: input.hostId,
          runId: input.runId,
          steadyCpuMillisByVm: input.steadyCpuMillisByVm,
          nowUnixMs: now,
        });
        if (
          result.ok &&
          result.state === "pending" &&
          result.expiresAt !== null
        ) {
          await this.scheduleAlarmNoLaterThan(result.expiresAt);
        }
        return jsonResponse(result, result.ok ? 201 : 409);
      }
      if (pathname.endsWith("/commit")) {
        const ok = await commitHostCpuReservation(db, {
          hostId: input.hostId,
          runId: input.runId,
          nowUnixMs: now,
        });
        if (ok) {
          try {
            if (
              this.ctx
                .getWebSockets(`host:${input.hostId}`)
                .some((socket) => socket.readyState === WebSocket.OPEN)
            ) {
              const activeSocket = await this.findActiveSocket(
                input.hostId,
                null,
              );
              if (activeSocket?.attachment.bridgeProtocol === "v6") {
                // The desired VM was committed before its CPU reservation.
                // Dispatch only after the reservation is durable, and retain
                // the final active-session fence inside the dispatcher.
                await this.dispatchBridgeDesiredStateIfNeeded(
                  input.hostId,
                  activeSocket.socket,
                );
              }
            }
          } catch (error) {
            // CPU commit is authoritative even if the socket disappears.
            // The alarm below retries desired delivery without making the
            // caller treat a committed reservation as pending or missing.
            console.error(
              JSON.stringify({
                message: "desired dispatch failed after CPU commit",
                hostId: input.hostId,
                runId: input.runId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          } finally {
            await this.scheduleAlarmNoLaterThan(
              Date.now() + DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
            );
          }
        }
        return jsonResponse({ ok });
      }
      if (pathname.endsWith("/rollback")) {
        const rolledBack = await rollbackPendingHostCpuReservation(db, input);
        return jsonResponse({ ok: true, rolledBack });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
  }

  private async withCpuReservationLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
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
      await this.applyBridgeStateReport(
        message.host_id,
        message.report,
        attachment.sessionId,
      );
      // State-report projection already reconciles CPU reservations.
      await this.reconcileHost(message.host_id, {
        reconcileCpuReservations: false,
      });
    } else if (message.type === "vm_report") {
      await this.applyBridgeVmReport(
        message.host_id,
        message.report,
        attachment.sessionId,
      );
      // VM-report projection owns this latency path. Desired-state commits
      // explicitly wake the host runtime; this alarm remains the durable
      // fallback without reloading desired state after every boot report.
      await this.scheduleAlarmNoLaterThan(
        Date.now() + DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
      );
    } else if (message.type === "build_report") {
      await this.applyBridgeBuildReport(
        message.host_id,
        message.report,
        attachment.sessionId,
      );
      await this.reconcileHost(message.host_id);
    } else if (message.type === "sync_request") {
      await this.dispatchBridgeDesiredStateIfNeeded(message.host_id, ws, {
        force: true,
      });
      await this.reconcileHost(message.host_id);
    } else {
      try {
        ws.close(1003, "server message type");
      } catch {
        // ignore
      }
      return;
    }
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

    // Deliver the current version through the same serialized path used by
    // wake/alarm/report events. Maintenance remains durable but no longer sits
    // in front of the initial desired-state handoff.
    try {
      await this.dispatchBridgeDesiredStateIfNeeded(message.host_id, ws);
    } finally {
      await this.scheduleAlarmNoLaterThan(
        Date.now() + DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
      );
    }
  }

  private async sendBridgeDesiredState(
    ws: WebSocket,
    attachment: SocketAttachment,
    hostId: string,
    state: HostDesiredStateV2,
  ): Promise<void> {
    const serialized = serializeBridgeMessageV6({
      type: "desired_state",
      protocol_version: 6,
      host_id: hostId,
      desired_state: state,
    });
    const dispatchedAtUnixMs = Date.now();
    ws.send(serialized);
    ws.serializeAttachment({
      ...attachment,
      lastDesiredVersionSent: state.version,
      lastDesiredDispatchAtMs: dispatchedAtUnixMs,
    });
  }

  private async applyBridgeStateReport(
    hostId: string,
    report: Extract<BridgeMessageV6, { type: "state_report" }>["report"],
    expectedSessionId: string,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    const acceptedActualState = await db
      .insert(hostActualState)
      .select(
        db
          .select({
            hostId: agentHosts.id,
            appliedDesiredVersion:
              sql<number>`${report.applied_desired_version}`.as(
                "applied_desired_version",
              ),
            observedAt: sql<number>`${report.observed_at_unix_ms}`.as(
              "observed_at",
            ),
            reportJson: sql<HostStateReportV2>`${JSON.stringify(report)}`.as(
              "report_json",
            ),
            createdAt: sql<number>`${now}`.as("created_at"),
            updatedAt: sql<number>`${now}`.as("updated_at"),
          })
          .from(agentHosts)
          .where(
            and(
              eq(agentHosts.id, hostId),
              eq(agentHosts.activeSessionId, expectedSessionId),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: hostActualState.hostId,
        set: {
          appliedDesiredVersion: report.applied_desired_version,
          observedAt: report.observed_at_unix_ms,
          reportJson: report,
          updatedAt: now,
        },
      })
      .returning({ hostId: hostActualState.hostId });
    if (!acceptedActualState.length) {
      return;
    }

    const heartbeat = await db
      .update(agentHosts)
      .set({
        connected: true,
        disconnectedAt: null,
        lastHeartbeatAt: now,
        lastInventoryAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentHosts.id, hostId),
          eq(agentHosts.activeSessionId, expectedSessionId),
        ),
      )
      .returning({ id: agentHosts.id });
    if (!heartbeat.length) return;

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
      await this.withRunProjectionLock(run.runId, async () => {
        // A direct VM report can arrive while an inventory report is awaiting
        // D1. Reload only after entering the per-run ordering domain so this
        // projection is always derived from the latest durable evidence.
        const current = await this.loadRun(run.runId);
        if (!current || current.hostId !== hostId) {
          return;
        }
        await this.persistRunState(
          run.runId,
          (latest) =>
            applyHostReportToRunState({
              runId: run.runId,
              current: latest,
              report,
            }),
          {
            keepDeleteRequestedAt: true,
            initialRow: current,
            expectedHostSession: {
              hostId,
              activeSessionId: expectedSessionId,
            },
          },
        );
      });
    }
    await this.withCpuReservationLock(async () => {
      await reconcileHostCpuReservations(db, hostId, now);
    });
  }

  private async applyBridgeVmReport(
    hostId: string,
    report: Extract<BridgeMessageV6, { type: "vm_report" }>["report"],
    expectedSessionId: string,
  ): Promise<void> {
    let projectionOutcome: RunProjectionOutcome | null = null;
    await this.withRunProjectionLock(report.run_id, async () => {
      const run = await this.loadRun(report.run_id);
      if (!run || run.hostId !== hostId) {
        return;
      }
      projectionOutcome = await this.persistRunState(
        report.run_id,
        (latest) =>
          applyVmReportToRunState({
            runId: report.run_id,
            current: latest,
            report,
          }),
        {
          keepDeleteRequestedAt: true,
          initialRow: run,
          expectedHostSession: { hostId, activeSessionId: expectedSessionId },
        },
      );
    });

    if (projectionOutcome === "stale_session") {
      return;
    }

    // Terminal readiness is durable before liveness maintenance. A slow host
    // heartbeat write can no longer hold the user-visible projection hostage.
    const heartbeatAt = Date.now();
    await drizzle(this.env.DB)
      .update(agentHosts)
      .set({
        connected: true,
        disconnectedAt: null,
        lastHeartbeatAt: heartbeatAt,
        updatedAt: heartbeatAt,
      })
      .where(
        and(
          eq(agentHosts.id, hostId),
          eq(agentHosts.activeSessionId, expectedSessionId),
        ),
      );
  }

  private async applyBridgeBuildReport(
    hostId: string,
    report: Extract<BridgeMessageV6, { type: "build_report" }>["report"],
    expectedSessionId: string,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    const heartbeat = await db
      .update(agentHosts)
      .set({
        connected: true,
        disconnectedAt: null,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentHosts.id, hostId),
          eq(agentHosts.activeSessionId, expectedSessionId),
        ),
      )
      .returning({ id: agentHosts.id });
    if (!heartbeat.length) return;
    const buildUpdates = await recordHostBuildReports(
      db,
      hostId,
      [report],
      now,
    );
    await this.removeTerminalBuildsFromDesiredState(
      hostId,
      buildUpdates.terminalBuildIds,
      now,
    );
  }

  private async reconcileHost(
    hostId: string,
    options?: { reconcileCpuReservations?: boolean },
  ): Promise<void> {
    const now = Date.now();
    const db = drizzle(this.env.DB);
    await maintainHostBuildAssignments(db, hostId, now);
    await expireOverdueRunLeases(hostId, now, {
      db,
      wakeHostRuntime: false,
    });
    if (options?.reconcileCpuReservations !== false) {
      await this.withCpuReservationLock(async () => {
        await reconcileHostCpuReservations(db, hostId, now);
      });
    }

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
        { force: shouldRepushLaggingVersion },
      );
    }

    await this.scheduleNextAlarm(hostId);
  }

  private async dispatchBridgeDesiredStateIfNeeded(
    hostId: string,
    ws: WebSocket,
    options?: { force?: boolean },
  ): Promise<void> {
    await this.withDesiredDispatchLock(async () => {
      const attachment = this.readSocketAttachment(ws);
      if (
        ws.readyState !== WebSocket.OPEN ||
        attachment?.bridgeProtocol !== "v6" ||
        !attachment.sessionId ||
        attachment.hostId !== hostId
      ) {
        return;
      }

      const desiredState = await loadOrCreateHostDesiredState(
        drizzle(this.env.DB),
        hostId,
        Date.now(),
      );
      // Make the host lookup the final await. Re-read the attachment after it
      // resolves, then validate and send synchronously so a replacement socket
      // cannot interleave between the active-session check and delivery.
      const host = await this.loadRequiredHost(hostId);
      const latestAttachment = this.readSocketAttachment(ws);
      if (
        ws.readyState !== WebSocket.OPEN ||
        latestAttachment?.bridgeProtocol !== "v6" ||
        !latestAttachment.sessionId ||
        latestAttachment.hostId !== hostId ||
        host.activeSessionId !== latestAttachment.sessionId
      ) {
        return;
      }

      const lastSent = latestAttachment.lastDesiredVersionSent;
      if (lastSent !== null && desiredState.version < lastSent) {
        console.warn(
          JSON.stringify({
            message: "refusing stale desired-state dispatch",
            hostId,
            desiredVersion: desiredState.version,
            lastSent,
          }),
        );
        return;
      }
      if (!options?.force && lastSent === desiredState.version) {
        return;
      }

      await this.sendBridgeDesiredState(
        ws,
        latestAttachment,
        hostId,
        desiredState,
      );
    });
  }

  private async withDesiredDispatchLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.desiredDispatchQueue;
    let release!: () => void;
    this.desiredDispatchQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
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

async function parseCpuReservationRequest(request: Request): Promise<{
  hostId: string;
  runId: string;
  steadyCpuMillisByVm: number[] | null;
} | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
    const runId = typeof value.runId === "string" ? value.runId.trim() : "";
    const steadyCpuMillisByVm = value.steadyCpuMillisByVm;
    if (
      !hostId ||
      hostId.length > 128 ||
      !runId ||
      runId.length > 128 ||
      (steadyCpuMillisByVm !== undefined &&
        (!Array.isArray(steadyCpuMillisByVm) ||
          steadyCpuMillisByVm.length === 0 ||
          steadyCpuMillisByVm.length > 256 ||
          !steadyCpuMillisByVm.every(isReservationCpuMillis)))
    ) {
      return null;
    }
    return {
      hostId,
      runId,
      steadyCpuMillisByVm: Array.isArray(steadyCpuMillisByVm)
        ? (steadyCpuMillisByVm as number[])
        : null,
    };
  } catch {
    return null;
  }
}

function isReservationCpuMillis(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 4_294_967_295
  );
}
