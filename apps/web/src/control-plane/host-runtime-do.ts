import { organizationHostAdmissionCondition } from "./auth";
import { enforceHostWorkloadAccess } from "@/lib/host-workload-access";
import { refreshStargateHostRelay, revokeStargateHostRelay, revokeStargateHostRelayCredentials } from "@/lib/stargate-relay";
import { persistHostReport } from "@/lib/personal-host-readiness";
import { learnerRunCliV1EnforcementEnabled } from "@/lib/run-cli-rollout";
import { notifyRunStatusListeners } from "./host-runtime-do/run-status-fanout";
import { traceOperation } from "@/lib/tracing";
import {
  DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
  RUNTIME_LEASE_CLEANUP_RETRY_MS,
  HOST_HELLO_TIMEOUT_MS,
  MAX_PENDING_HOST_SOCKETS,
  MAX_STATUS_SOCKETS,
  MAX_STATUS_SOCKETS_PER_USER,
  STATUS_SOCKET_LIFETIME_MS,
  HostRuntimeBase,
  type RunProjectionOutcome,
  type RunStatusSocketAttachment,
  type SocketAttachment,
} from "./host-runtime-do/base";
import { and, eq, exists, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  parseBridgeMessageV8,
  serializeBridgeMessageV8,
} from "@/control-plane/bridge-v8";
import {
  accessAllowlist,
  agentHosts,
  hostActualState,
  hostDesiredState,
  hostResourceReservations,
  type RuntimeExecutionState,
} from "@/db/schema";
import {
  reconcileHostCpuReservations,
} from "@/control-plane/host-cpu-reservations";
import { createAppId } from "@/lib/id";
import {
  applyHostReportToRunState,
  applyVmReportToRunState,
} from "@/lib/run-lifecycle";
import { loadOrCreateHostDesiredState, mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import {
  maintainHostBuildAssignments,
  recordHostBuildReports,
} from "@/lib/build-scheduler";
import { expireOverdueRunLeases } from "@/lib/scenario-runs";
import { expireOverdueRuntimeExecutions } from "@/lib/runtime-lease-expiry";
import { recordRuntimeVmActualState } from "@/lib/runtime-vm-state";
import {
  attachReadyScenarioTerminalTargets,
  reconcileScenarioTerminalRouteAttachments,
} from "@/lib/scenario-terminal-attach";
import { StargateTerminalAttachError } from "@/lib/stargate";
import {
  isReportedHostRoleAllowed,
} from "@/lib/scenario-hosts";
import type {
  BridgeMessageV8,
  HostCapabilitiesV2,
  HostRelayCredentials,
  HostDesiredStateV2,
  VmActualStateV2,
  VmReportV2,
} from "@/generated/bridge";
import { reconcileHostScenarioImages } from "@/lib/scenario-image-cache";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import {
  controlPlaneMaintenanceEnabled,
  maintenanceJsonResponse,
} from "@/maintenance";

export const SCENARIO_IMAGE_CACHE_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const SCENARIO_IMAGE_CACHE_NEXT_RECONCILIATION_STORAGE_KEY =
  "scenario-image-cache-next-reconciliation-at-ms";

type RuntimeVmReportContext = {
  executionId: string;
  userId: string;
  organizationId: string | null;
  hostId: string;
  domainKind: "scenario";
  domainId: string;
  generation: number;
  state: RuntimeExecutionState;
  archiveRequestedAt: number | null;
  runtimeVmId: string;
  vmId: string;
  runtimeVmName: string;
};

export class HostRuntimeDO extends HostRuntimeBase {
  private cpuReservationQueue: Promise<void> = Promise.resolve();
  private desiredDispatchQueue: Promise<void> = Promise.resolve();
  private clientHelloQueue: Promise<void> = Promise.resolve();
  private readonly pendingClientHellos = new Set<WebSocket>();
  private nextScenarioImageCacheReconciliationAtMs: number | null = null;
  private sendingStatusNotifications = false;
  private readonly pendingStatusNotifications = new Map<
    string, { runId: string; hostId: string; revision: number }
  >();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (controlPlaneMaintenanceEnabled(this.env) && url.pathname !== "/_internal/retire") {
      return maintenanceJsonResponse();
    }

    if (url.pathname === "/connect") {
      return traceOperation("host.handleConnect", () => this.handleConnect(request));
    }

    if (url.pathname === "/_internal/run-status") {
      return traceOperation("host.handleRunStatusStream", () => this.handleRunStatusStream(request));
    }

    if (url.pathname === "/_internal/wake") {
      return traceOperation("host.handleWake", () => this.handleWake(request));
    }

    if (url.pathname === "/_internal/retire") {
      return traceOperation("host.handleRetire", () => this.handleRetire(request));
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  override async alarm(): Promise<void> {
    this.closeExpiredSockets();
    if (controlPlaneMaintenanceEnabled(this.env)) {
      // Maintenance must not leave accepted sockets alive without a deadline.
      for (const socket of this.ctx.getWebSockets()) socket.close(1012, "maintenance");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!(await this.runtimeAlarmIsDue())) {
      await this.scheduleSocketExpiry();
      return;
    }
    const hostId = await this.loadKnownHostId();
    if (!hostId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await traceOperation("host.reconcile", () => this.reconcileHost(hostId), { "intar.host.id": hostId });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (controlPlaneMaintenanceEnabled(this.env)) {
      try {
        ws.close(1012, "maintenance");
      } catch {
        // ignore an already-closed hibernatable socket
      }
      return;
    }
    const statusAttachment = this.readRunStatusSocketAttachment(ws);
    if (statusAttachment) {
      try {
        ws.close(1003, "run status stream is server-only");
      } catch {
        // ignore an already-closed hibernatable socket
      }
      return;
    }

    const attachment = this.readSocketAttachment(ws);
    if (!attachment) {
      try {
        ws.close(1008, "missing attachment");
      } catch {
        // ignore
      }
      return;
    }

    const bridgeMessage = parseBridgeMessageV8(message);
    if (bridgeMessage) {
      await traceOperation("host.bridge.message", () => this.handleBridgeMessageV8(ws, attachment, bridgeMessage), { "intar.bridge.message_type": bridgeMessage.type });
      return;
    }

    try {
      ws.close(1003, "invalid bridge v7 message");
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
    if (controlPlaneMaintenanceEnabled(this.env)) return;
    if (this.readRunStatusSocketAttachment(ws)) return;
    await this.handleSocketClosed(ws);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (controlPlaneMaintenanceEnabled(this.env)) return;
    if (this.readRunStatusSocketAttachment(ws)) return;
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

    const credentialGeneration = Number(request.headers.get("x-agent-credential-generation"));
    if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1) {
      return jsonResponse({ error: "invalid credential generation" }, 401);
    }
    const parsedBetaAdmission = parseBetaAdmissionHeaders(request.headers);
    if (!parsedBetaAdmission.valid) {
      return jsonResponse({ error: "invalid beta admission" }, 401);
    }
    const betaAdmission = parsedBetaAdmission.admission;
    const admission = await this.loadHostConnectionAdmission(hostId);
    if (!admission) {
      return jsonResponse({ error: "host not found" }, 404);
    }
    if (!admission.scope || admission.credentialGeneration !== credentialGeneration) {
      return jsonResponse({ error: "server credentials changed" }, 401);
    }
    if (admission.scope === "organization" && request.headers.get("x-agent-organization-id") !== admission.organizationId) {
      return jsonResponse({ error: "organization credentials changed" }, 401);
    }
    if (admission.disabled) {
      await this.retireRuntimeState(hostId, "host disabled");
      return jsonResponse({ error: "host is disabled" }, 403);
    }
    if (admission.scope === "personal") {
      if (admission.betaAdmission === null) {
        await this.retireRuntimeState(hostId, "beta access revoked");
        return jsonResponse({ error: "beta access is revoked" }, 403);
      }
      if (!sameBetaAdmission(betaAdmission, admission.betaAdmission)) {
        return jsonResponse({ error: "stale beta admission" }, 401);
      }
    } else if (betaAdmission !== null) {
      return jsonResponse(
        { error: "invalid host admission" },
        401,
      );
    }

    await this.persistKnownHostId(hostId);

    this.closeExpiredSockets();
    const hostSockets = this.ctx.getWebSockets("host");
    if (
      hostSockets.length >= MAX_PENDING_HOST_SOCKETS + 1 ||
      hostSockets.filter(socket => !this.readSocketAttachment(socket)?.helloReceived).length >= MAX_PENDING_HOST_SOCKETS
    ) {
      return jsonResponse({ error: "too many pending host connections" }, 429);
    }
    // No await between the count and accept: concurrent upgrades share this cap.
    const connectedAt = Date.now();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, ["host", `host:${hostId}`]);

    server.serializeAttachment({
      kind: "agent",
      hostId,
      credentialGeneration,
      scope: admission.scope,
      organizationId: admission.organizationId,
      sessionId: null,
      betaSourceInviteId: betaAdmission?.sourceInviteId ?? null,
      betaSourceLeaseId: betaAdmission?.sourceLeaseId ?? null,
      betaAdmissionGrantedAt: betaAdmission?.grantedAt ?? null,
      connectedAt,
      helloReceived: false,
      bridgeProtocol: null,
      lastDesiredVersionSent: null,
      lastDesiredDispatchAtMs: null,
    } satisfies SocketAttachment);

    await this.scheduleSocketExpiry();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleRunStatusStream(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "expected websocket upgrade" }, 426);
    }

    const subscription = parseRunStatusStreamAttachment(request.headers);
    if (!subscription) {
      return jsonResponse({ error: "invalid run status subscription" }, 400);
    }
    const knownHostId = await this.loadKnownHostId();
    if (knownHostId && knownHostId !== subscription.hostId) {
      return jsonResponse(
        { error: "host id does not match durable object" },
        409,
      );
    }
    const sessionExpiresAt = await this.loadRunStatusSessionExpiry(subscription);
    if (sessionExpiresAt === null) {
      return jsonResponse({ error: "run status access is no longer active" }, 403);
    }

    const attachment: RunStatusSocketAttachment = {
      ...subscription,
      expiresAt: Math.min(sessionExpiresAt, Date.now() + STATUS_SOCKET_LIFETIME_MS),
    };
    await this.persistKnownHostId(attachment.hostId);
    this.closeExpiredSockets();
    if (attachment.expiresAt <= Date.now()) {
      return jsonResponse({ error: "run status session expired" }, 403);
    }
    const listeners = this.ctx.getWebSockets("run-status");
    if (
      listeners.length >= MAX_STATUS_SOCKETS ||
      listeners.filter(socket => this.readRunStatusSocketAttachment(socket)?.userId === attachment.userId).length >= MAX_STATUS_SOCKETS_PER_USER
    ) {
      return jsonResponse({ error: "too many run status connections" }, 429);
    }
    // Count all retained sockets, including closing ones, across this user's
    // runs and sessions. Status listeners cannot consume agent socket capacity.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [
      "run-status",
      `run-status:${attachment.runId}`,
      `run-status-host:${attachment.hostId}`,
    ]);
    server.serializeAttachment(attachment);
    try {
      await this.scheduleSocketExpiry();
      server.send(
        JSON.stringify({ type: "subscribed", runId: attachment.runId }),
      );
    } catch {
      try {
        server.close(1011, "run status subscription failed");
      } catch {
        // ignore an already-closed hibernatable socket
      }
      return jsonResponse({ error: "run status subscription failed" }, 500);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private scheduleRunStatusInvalidation(input: {
    runId: string;
    hostId: string;
    revision: number;
  }): void {
    const pending = this.pendingStatusNotifications.get(input.runId);
    if (pending) {
      pending.revision = Math.max(pending.revision, input.revision);
      return;
    }
    this.pendingStatusNotifications.set(input.runId, { ...input });
    if (this.sendingStatusNotifications) return;
    this.sendingStatusNotifications = true;
    this.ctx.waitUntil(this.flushRunStatusInvalidations());
  }

  private async flushRunStatusInvalidations(): Promise<void> {
    try {
      // One broadcast per host, including when several runs change together.
      // Reinserted runs go to the tail, so a busy run cannot starve the rest.
      for (;;) {
        const input = this.pendingStatusNotifications.values().next().value;
        if (!input) return;
        this.pendingStatusNotifications.delete(input.runId);
        try {
          await this.notifyRunStatusInvalidation(input);
        } catch (error) {
          console.error(JSON.stringify({
            message: "failed to notify scenario status subscribers",
            runId: input.runId, hostId: input.hostId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    } finally {
      this.sendingStatusNotifications = false;
    }
  }

  private async notifyRunStatusInvalidation(input: {
    runId: string;
    hostId: string;
    revision: number;
  }): Promise<void> {
    await notifyRunStatusListeners(
      this.env.DB,
      this.ctx.getWebSockets(`run-status:${input.runId}`),
      socket => this.readRunStatusSocketAttachment(socket),
      input,
    );
  }

  private async loadRunStatusSessionExpiry(
    attachment: Omit<RunStatusSocketAttachment, "expiresAt">,
  ): Promise<number | null> {
    const row = await this.env.DB.prepare(
      `SELECT auth_session.expires_at
       FROM scenario_runs run
       INNER JOIN session auth_session
         ON auth_session.id = ?1
        AND auth_session.user_id = run.user_id
        AND auth_session.expires_at > ?2
       INNER JOIN access_allowlist access
         ON access.user_id = run.user_id
        AND access.state = 'active'
        AND access.source_invite_id = ?3
        AND access.source_lease_id = ?4
        AND access.granted_at = ?5
       WHERE run.run_id = ?6
         AND run.user_id = ?7
         AND run.host_id = ?8
       LIMIT 1`,
    )
      .bind(
        attachment.sessionId,
        Date.now(),
        attachment.betaSourceInviteId,
        attachment.betaSourceLeaseId,
        attachment.betaAdmissionGrantedAt,
        attachment.runId,
        attachment.userId,
        attachment.hostId,
      )
      .first<{ expires_at: number }>();
    return row?.expires_at ?? null;
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
    try {
      await this.retireRuntimeState(hostId, "host retired", 1001);
    } catch (error) {
      console.error(JSON.stringify({
        message: "host retirement incomplete", hostId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonResponse({ error: "host retirement incomplete" }, 503);
    }
    return jsonResponse({ ok: true, hostId, alarmCleared: await this.ctx.storage.getAlarm() === null });
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

  private async handleBridgeMessageV8(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: BridgeMessageV8,
  ): Promise<void> {
    if (message.type === "client_hello") {
      if (attachment.helloReceived || this.pendingClientHellos.has(ws)) {
        ws.close(1008, "client hello already received");
        return;
      }
      this.pendingClientHellos.add(ws);
      try {
        await this.withClientHelloLock(() =>
          this.handleBridgeClientHello(ws, attachment, message),
        );
      } finally {
        this.pendingClientHellos.delete(ws);
      }
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

    if (
      !(await this.isCurrentHostSessionAdmission(
        attachment.hostId,
        attachment.sessionId,
        betaAdmissionFromAttachment(attachment),
        attachment.credentialGeneration,
        attachment.organizationId,
      ))
    ) {
      await this.rejectClientHelloAdmission(
        ws,
        attachment.hostId,
        "host admission is no longer active",
      );
      return;
    }

    if (message.type === "state_report") {
      await this.applyBridgeStateReport(
        message.host_id,
        message.report,
        attachment.sessionId,
        attachment.credentialGeneration,
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
        attachment.credentialGeneration,
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
        attachment.credentialGeneration,
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
    message: Extract<BridgeMessageV8, { type: "client_hello" }>,
  ): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (attachment.connectedAt + HOST_HELLO_TIMEOUT_MS <= Date.now()) {
      ws.close(1008, "client hello expired");
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

    const sessionId = createAppId();
    const pendingAttachment: SocketAttachment = {
      ...attachment,
      sessionId,
      // Keep the socket in handshake state until server_hello is ready. A
      // concurrent wake must not send desired_state first; the agent rejects
      // any first server frame other than server_hello.
      helloReceived: false,
      bridgeProtocol: null,
      lastDesiredVersionSent: null,
      lastDesiredDispatchAtMs: null,
    };
    ws.serializeAttachment(pendingAttachment);

    await this.persistKnownHostId(message.host_id);
    const db = drizzle(this.env.DB);
    const socketBetaAdmission = betaAdmissionFromAttachment(attachment);
    const admissionFence = host.scope === "personal" && socketBetaAdmission
      ? exists(
          db.select({ userId: accessAllowlist.userId }).from(accessAllowlist).where(and(
            eq(accessAllowlist.userId, host.userId),
            eq(accessAllowlist.state, "active"),
            eq(accessAllowlist.sourceInviteId, socketBetaAdmission.sourceInviteId),
            eq(accessAllowlist.sourceLeaseId, socketBetaAdmission.sourceLeaseId),
            eq(accessAllowlist.grantedAt, socketBetaAdmission.grantedAt),
          )),
        )
      : host.scope === "organization" && socketBetaAdmission === null && attachment.organizationId === host.organizationId
        ? sql`${agentHosts.role} = 'agent' AND ${agentHosts.organizationId} = ${host.organizationId}
            AND ${sql.raw(organizationHostAdmissionCondition("agent_hosts.organization_id"))}`
        : host.scope === "platform" && socketBetaAdmission === null
        ? sql`1 = 1`
        : undefined;
    const activationFence = admissionFence && host.scope
      ? and(
          eq(agentHosts.id, message.host_id),
          eq(agentHosts.userId, host.userId),
          eq(agentHosts.scope, host.scope),
          eq(agentHosts.credentialGeneration, attachment.credentialGeneration),
          eq(agentHosts.disabled, false),
          admissionFence,
        )
      : undefined;
    if (!activationFence) {
      await this.rejectClientHelloAdmission(
        ws,
        message.host_id,
        "beta admission required",
      );
      return;
    }
    const [activated] = await db.batch([
      db
        .update(agentHosts)
        .set({
          activeSessionId: sessionId,
          scenarioEnabled: sql`case when ${agentHosts.role} = 'builder' then 0 else ${agentHosts.scenarioEnabled} end`,
          connected: true,
          connectedAt: sql`max(coalesce(${agentHosts.connectedAt}, 0) + 1, ${now})`,
          disconnectedAt: null,
          lastClientHelloAt: now,
          lastServerHelloAt: now,
          agentVersion: message.agent_version,
          updatedAt: now,
        })
        .where(activationFence)
        .returning({ id: agentHosts.id }),
      // host_actual_state has no session column. Clearing it in the same
      // transaction as the session swap makes any subsequently accepted row
      // current-session evidence, without relying on millisecond timestamps.
      db
        .delete(hostActualState)
        .where(
          and(
            eq(hostActualState.hostId, message.host_id),
            exists(
              db
                .select({ id: agentHosts.id })
                .from(agentHosts)
                .where(
                  and(
                    eq(agentHosts.id, message.host_id),
                    eq(agentHosts.activeSessionId, sessionId),
                  ),
                ),
            ),
          ),
        ),
    ]);
    if (!activated.length) {
      await this.rejectClientHelloAdmission(
        ws,
        message.host_id,
        "host admission changed during hello",
      );
      return;
    }

    // Persist the session fence before trusting the hello architecture. Bulk
    // catalog reconciliation cannot see actual-state reports from before this
    // hello, and the desired-state CAS below is tied to this exact session.
    let reconciliation: Awaited<ReturnType<typeof reconcileHostScenarioImages>>;
    try {
      reconciliation = await reconcileHostScenarioImages(db, {
        hostId: message.host_id,
        architecture: message.capabilities.arch,
        nowUnixMs: now,
        expectedActiveSessionId: sessionId,
      });
    } catch (error) {
      await this.rollbackPendingClientHello(db, host, sessionId);
      try {
        ws.close(1011, "host image reconciliation failed");
      } catch {
        // ignore
      }
      throw error;
    }
    const desiredState = reconciliation.desiredState;
    const admissionStillCurrent = await this.isCurrentHostSessionAdmission(
      message.host_id,
      sessionId,
      socketBetaAdmission,
      attachment.credentialGeneration,
      attachment.organizationId,
    );
    if (!admissionStillCurrent) {
      await this.rollbackPendingClientHello(db, host, sessionId);
      await this.rejectClientHelloAdmission(
        ws,
        message.host_id,
        "host admission changed during hello",
      );
      return;
    }
    if (
      !desiredState ||
      reconciliation.outcome === "stale_host_snapshot" ||
      ws.readyState !== WebSocket.OPEN ||
      attachment.connectedAt + HOST_HELLO_TIMEOUT_MS <= Date.now()
    ) {
      await this.rollbackPendingClientHello(db, host, sessionId);
      try {
        ws.close(1012, "host session changed during hello");
      } catch {
        // ignore
      }
      return;
    }
    const nextAttachment: SocketAttachment = {
      ...pendingAttachment,
      helloReceived: true,
      bridgeProtocol: "v6",
      lastDesiredVersionSent:
        message.last_applied_desired_version === desiredState.version
          ? desiredState.version
          : null,
    };
    try {
      // No await is allowed between promoting the attachment and this frame:
      // server_hello must be the first server message on a v6 connection.
      ws.serializeAttachment(nextAttachment);
      ws.send(
        serializeBridgeMessageV8({
          type: "server_hello",
          protocol_version: message.protocol_version,
          host_id: message.host_id,
          session_id: sessionId,
          desired_version: desiredState.version,
          relay: null,
        }),
      );
    } catch (error) {
      await this.rollbackPendingClientHello(db, host, sessionId);
      try {
        ws.close(1011, "server hello failed");
      } catch {
        // ignore
      }
      throw error;
    }

    this.nextScenarioImageCacheReconciliationAtMs = 0;
    try {
      await this.ctx.storage.delete(
        SCENARIO_IMAGE_CACHE_NEXT_RECONCILIATION_STORAGE_KEY,
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "failed to reset scenario image reconciliation schedule",
          hostId: message.host_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    await this.closeOlderSockets(message.host_id, ws, sessionId);

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
    relay: HostRelayCredentials | null,
  ): Promise<void> {
    const serialized = serializeBridgeMessageV8({
      type: "desired_state",
      protocol_version: 8,
      host_id: hostId,
      desired_state: state,
      relay,
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
    report: Extract<BridgeMessageV8, { type: "state_report" }>["report"],
    expectedSessionId: string,
    expectedCredentialGeneration: number,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const now = Date.now();
    const accepted = await persistHostReport({
      d1: this.env.DB, hostId, report, now,
      sessionId: expectedSessionId,
      credentialGeneration: expectedCredentialGeneration,
      requireRunCli: learnerRunCliV1EnforcementEnabled(this.env),
    });
    if (!accepted) return;

    const buildUpdates = await recordHostBuildReports(
      db,
      hostId,
      report.builds,
      now,
      { sessionId: expectedSessionId, credentialGeneration: expectedCredentialGeneration },
    );
    await this.removeTerminalBuildsFromDesiredState(
      hostId,
      buildUpdates.terminalBuildIds,
      now,
    );

    const runs = await this.listOpenRunsForHost(hostId);
    for (const run of runs) {
      if (report.vms.some(vm => vm.run_id === run.runId && (vm.runtime_execution_id !== run.executionId ||
        vm.generation !== run.executionGeneration || vm.owner_user_id !== run.userId))) continue;
      const projectionOutcome = await this.withRunProjectionLock(
        run.runId,
        async () => {
          // A direct VM report can arrive while an inventory report is awaiting
          // D1. Reload only after entering the per-run ordering domain so this
          // projection is always derived from the latest durable evidence.
          const current = await this.loadRun(run.runId);
          if (!current || current.hostId !== hostId) {
            return { kind: "unchanged" } satisfies RunProjectionOutcome;
          }
          return this.persistRunState(
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
              expectedExecution: { id: run.executionId, ownerUserId: run.userId, generation: run.executionGeneration },
              expectedHostSession: {
                hostId,
                activeSessionId: expectedSessionId,
                credentialGeneration: expectedCredentialGeneration,
              },
            },
          );
        },
      );
      if (projectionOutcome.kind === "updated") {
        this.scheduleRunStatusInvalidation({
          runId: run.runId,
          hostId,
          revision: projectionOutcome.revision,
        });
      }
    }
    await this.withCpuReservationLock(async () => {
      await reconcileHostCpuReservations(db, hostId, now);
    });

    try {
      await this.reconcileScenarioImageCacheIfDue({
        db,
        hostId,
        architecture: report.capabilities.arch,
        expectedSessionId,
        nowUnixMs: now,
      });
    } catch (error) {
      // Cache repair is durable, best-effort maintenance. Never discard an
      // authoritative inventory report because catalog reconciliation failed;
      // leave the due marker unchanged so the next report retries.
      console.error(
        JSON.stringify({
          message: "periodic scenario image cache reconciliation failed",
          hostId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async applyBridgeVmReport(
    hostId: string,
    report: Extract<BridgeMessageV8, { type: "vm_report" }>["report"],
    expectedSessionId: string,
    expectedCredentialGeneration: number,
  ): Promise<void> {
    const execution = await this.loadRuntimeVmReportContext(hostId, report.runtime_execution_id, report.vm_name);
    if (!execution || execution.domainId !== report.run_id || execution.userId !== report.owner_user_id ||
      execution.generation !== report.generation || execution.state === "archived") return;
    const projectionOutcome = await this.withRunProjectionLock(
      report.run_id,
      async (): Promise<RunProjectionOutcome> => {
        const run = await this.loadRun(report.run_id);
        const outcome =
          run?.hostId === hostId
            ? await this.persistRunState(
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
                  expectedExecution: { id: report.runtime_execution_id, ownerUserId: report.owner_user_id, generation: report.generation },
                  expectedHostSession: {
                    hostId,
                    activeSessionId: expectedSessionId,
                    credentialGeneration: expectedCredentialGeneration,
                  },
                },
              )
            : ({ kind: "unchanged" } satisfies RunProjectionOutcome);

        if (outcome.kind === "updated") {
          // The status route reads the durable projection. Begin this
          // best-effort notification only after that write, without awaiting it
          // under the ordering lock for the runtime mirror.
          this.scheduleRunStatusInvalidation({
            runId: report.run_id,
            hostId,
            revision: outcome.revision,
          });
        }

        if (outcome.kind !== "stale_session") {
          try {
            await this.applyRuntimeVmActualState(
              hostId,
              runtimeActualStateFromReport(report),
              report.observed_at_unix_ms,
              expectedSessionId,
              expectedCredentialGeneration,
            );
          } catch (error) {
            // Scenario projection remains authoritative during the shared-runtime
            // migration. A missing mirror credential must not regress its
            // established lifecycle. Mirror errors are retried by the agent's next
            // report.
            console.error(
              JSON.stringify({
                message: "runtime VM report projection failed",
                hostId,
                executionId: report.run_id,
                runtimeVmName: report.vm_name,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }
        return outcome;
      },
    );

    if (projectionOutcome.kind === "stale_session") {
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
          eq(agentHosts.credentialGeneration, expectedCredentialGeneration),
          eq(agentHosts.disabled, false),
        ),
      );
  }

  private async applyRuntimeVmActualState(
    hostId: string,
    report: VmActualStateV2,
    observedAt: number,
    expectedSessionId: string,
    expectedCredentialGeneration: number,
  ): Promise<void> {
    const context = await this.loadRuntimeVmReportContext(
      hostId,
      report.runtime_execution_id,
      report.vm_name,
    );
    if (!context || context.userId !== report.owner_user_id || context.generation !== report.generation || context.domainId !== report.run_id || context.state === "archived") return;
    const outcome = await recordRuntimeVmActualState({
      executionId: context.executionId,
      expectedGeneration: context.generation,
      vmId: context.vmId,
      hostId,
      report,
      observedAt,
      expectedHostSessionId: expectedSessionId,
      expectedHostCredentialGeneration: expectedCredentialGeneration,
    });
    if (outcome === "stale") return;

    const now = observedAt;
    const reservationCommitAt = Date.now();
    await drizzle(this.env.DB)
      .update(hostResourceReservations)
      .set({ state: "committed", updatedAt: now })
      .where(
        and(
          eq(hostResourceReservations.executionId, context.executionId),
          eq(hostResourceReservations.hostId, hostId),
          eq(hostResourceReservations.state, "pending"),
          sql`(${hostResourceReservations.expiresAt} IS NULL OR ${hostResourceReservations.expiresAt} > ${reservationCommitAt})`,
        ),
      );

    // The run projection and the runtime mirror both committed, so a ready
    // terminal target for this VM is now durable. Attaching on this report is
    // the latency path: the alarm reconcile is the fallback that catches a
    // transient gateway or D1 failure, and the gateway treats a repeat attach
    // as a no-op.
    this.scheduleScenarioTerminalAttach({
      executionId: context.executionId,
      expectedGeneration: context.generation,
      expectedUserId: context.userId,
      hostId,
      runId: context.domainId,
      vmId: context.vmId,
      expectedHostSessionId: expectedSessionId,
    });
  }

  /**
   * Runs the terminal attach for one reported VM under the request lifetime,
   * so the guest endpoint reaches the learner's open route without waiting for
   * the next alarm. The failure log carries a fixed code and never the raw
   * error: a gateway error body can echo request fields, and the attach body
   * carries the guest private key.
   */
  private scheduleScenarioTerminalAttach(input: {
    executionId: string;
    expectedGeneration: number;
    expectedUserId: string;
    hostId: string;
    runId: string;
    vmId: string;
    expectedHostSessionId: string;
  }): void {
    this.ctx.waitUntil(
      attachReadyScenarioTerminalTargets(input).then(
        () => undefined,
        (error: unknown) => {
          console.warn(
            JSON.stringify({
              message: "scenario terminal attach failed on vm report",
              hostId: input.hostId,
              runId: input.runId,
              vmId: input.vmId,
              code: attachFailureCode(error),
            }),
          );
        },
      ),
    );
  }

  private async loadRuntimeVmReportContext(
    hostId: string,
    executionId: string,
    runtimeVmName: string,
  ): Promise<RuntimeVmReportContext | null> {
    const row = await this.env.DB.prepare(
      `SELECT
         execution.id AS execution_id,
         execution.user_id,
         execution.organization_id,
         execution.host_id,
         execution.domain_kind,
         execution.domain_id,
         execution.generation,
         execution.state,
         execution.archive_requested_at,
         vm.id AS runtime_vm_id,
         vm.vm_id,
         vm.runtime_vm_name
       FROM runtime_executions execution
       INNER JOIN runtime_vms vm ON vm.execution_id = execution.id
       WHERE execution.id = ?
         AND execution.host_id = ?
         AND vm.runtime_vm_name = ?
         AND NOT EXISTS (
           SELECT 1 FROM runtime_executions newer
           WHERE newer.domain_kind = execution.domain_kind
             AND newer.domain_id = execution.domain_id
             AND newer.generation > execution.generation
         )
       LIMIT 1`,
    )
      .bind(executionId, hostId, runtimeVmName)
      .first<{
        execution_id: string;
        user_id: string;
        organization_id: string | null;
        host_id: string;
        domain_kind: "scenario";
        domain_id: string;
        generation: number;
        state: RuntimeExecutionState;
        archive_requested_at: number | null;
        runtime_vm_id: string;
        vm_id: string;
        runtime_vm_name: string;
      }>();
    if (!row) return null;
    return {
      executionId: row.execution_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      hostId: row.host_id,
      domainKind: row.domain_kind,
      domainId: row.domain_id,
      generation: row.generation,
      state: row.state,
      archiveRequestedAt: row.archive_requested_at,
      runtimeVmId: row.runtime_vm_id,
      vmId: row.vm_id,
      runtimeVmName: row.runtime_vm_name,
    };
  }

  private async applyBridgeBuildReport(
    hostId: string,
    report: Extract<BridgeMessageV8, { type: "build_report" }>["report"],
    expectedSessionId: string,
    expectedCredentialGeneration: number,
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
          eq(agentHosts.credentialGeneration, expectedCredentialGeneration),
          eq(agentHosts.disabled, false),
        ),
      )
      .returning({ id: agentHosts.id });
    if (!heartbeat.length) return;
    const buildUpdates = await recordHostBuildReports(
      db,
      hostId,
      [report],
      now,
      { sessionId: expectedSessionId, credentialGeneration: expectedCredentialGeneration },
    );
    await this.removeTerminalBuildsFromDesiredState(
      hostId,
      buildUpdates.terminalBuildIds,
      now,
    );
  }

  private async reconcileHost(
    hostId: string,
    options?: {
      reconcileCpuReservations?: boolean;
    },
  ): Promise<void> {
    const now = Date.now();
    const db = drizzle(this.env.DB);
    await maintainHostBuildAssignments(db, hostId, now);
    const expiredLeases = await expireOverdueRunLeases(hostId, now, {
      db,
      wakeHostRuntime: false,
    });
    for (const expired of expiredLeases.updatedRunRevisions) {
      this.scheduleRunStatusInvalidation({
        runId: expired.runId,
        hostId,
        revision: expired.revision,
      });
    }
    await expireOverdueRuntimeExecutions(hostId, now);
    if (options?.reconcileCpuReservations !== false) {
      await this.withCpuReservationLock(async () => {
        await reconcileHostCpuReservations(db, hostId, now);
      });
    }
    // Terminal attach retries ride the reconcile path because the runtime
    // mirror row is the durable work marker: a target that is recorded but
    // not yet marked attached is re-sent, and the gateway treats a repeat
    // attach as a no-op.
    try {
      await reconcileScenarioTerminalRouteAttachments({ hostId });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "scenario terminal attach reconcile failed",
          hostId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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

      const desiredState = await enforceHostWorkloadAccess(await loadOrCreateHostDesiredState(
        drizzle(this.env.DB),
        hostId,
        Date.now(),
      ));
      const lastSent = attachment.lastDesiredVersionSent;
      if (lastSent !== null && desiredState.version < lastSent) return;
      const relayRefreshDue = desiredState.scope !== "platform" &&
        (attachment.lastDesiredDispatchAtMs === null || Date.now() - attachment.lastDesiredDispatchAtMs >= 45_000);
      if (!options?.force && !relayRefreshDue && lastSent === desiredState.version) return;
      let relay: HostRelayCredentials | null;
      try {
        relay = await refreshStargateHostRelay({ hostId, sessionId: attachment.sessionId,
          credentialGeneration: attachment.credentialGeneration });
      } catch (error) {
        // A failed grant is revoked at Stargate. Reusing this control session
        // would retry a revoked identity; reconnect to obtain a fresh one.
        console.warn(JSON.stringify({ event: "host_relay_reconnect_required", hostId,
          error: error instanceof Error ? error.message : String(error) }));
        try { ws.close(1012, "relay session must reconnect"); } catch { /* already closed */ }
        await this.scheduleAlarmNoLaterThan(Date.now() + RUNTIME_LEASE_CLEANUP_RETRY_MS);
        return;
      }
      // Make the host lookup the final await. Re-read the attachment after it
      // resolves, then validate and send synchronously so a replacement socket
      // cannot interleave between the active-session check and delivery.
      const admissionStillCurrent = await this.isCurrentHostSessionAdmission(
        hostId,
        attachment.sessionId,
        betaAdmissionFromAttachment(attachment),
        attachment.credentialGeneration,
        attachment.organizationId,
      );
      const latestAttachment = this.readSocketAttachment(ws);
      if (
        !admissionStillCurrent ||
        ws.readyState !== WebSocket.OPEN ||
        latestAttachment?.bridgeProtocol !== "v6" ||
        !latestAttachment.sessionId ||
        latestAttachment.hostId !== hostId ||
        latestAttachment.sessionId !== attachment.sessionId
      ) {
        if (desiredState.scope !== "platform") await revokeStargateHostRelay({ hostId, sessionId: attachment.sessionId,
          credentialGeneration: attachment.credentialGeneration });
        return;
      }

      await this.sendBridgeDesiredState(
        ws,
        latestAttachment,
        hostId,
        desiredState,
        relay,
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

  private async withClientHelloLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.clientHelloQueue;
    let release!: () => void;
    this.clientHelloQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async rollbackPendingClientHello(
    db: DrizzleD1Database,
    previousHost: typeof agentHosts.$inferSelect,
    pendingSessionId: string,
  ): Promise<void> {
    const now = Date.now();
    const disconnectedHost = await db
      .update(agentHosts)
      .set({
        // Fail closed instead of reviving the previous session: that socket
        // may have closed while the replacement handshake was awaiting D1.
        // Closing it below forces the agent through a fresh hello/report and
        // prevents ghost readiness based on unowned actual-state evidence.
        activeSessionId: null,
        connected: false,
        disconnectedAt: now,
        lastClientHelloAt: previousHost.lastClientHelloAt,
        lastServerHelloAt: previousHost.lastServerHelloAt,
        agentVersion: previousHost.agentVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentHosts.id, previousHost.id),
          eq(agentHosts.activeSessionId, pendingSessionId),
        ),
      )
      .returning({ id: agentHosts.id });
    if (!disconnectedHost.length || !previousHost.activeSessionId) return;

    for (const socket of this.ctx.getWebSockets(`host:${previousHost.id}`)) {
      const socketAttachment = this.readSocketAttachment(socket);
      if (socketAttachment?.sessionId !== previousHost.activeSessionId) {
        continue;
      }
      try {
        socket.close(1012, "replacement handshake failed");
      } catch {
        // The previous socket may already be closing.
      }
    }
  }

  private async loadHostConnectionAdmission(hostId: string): Promise<{
    scope: "personal" | "platform" | "organization" | null;
    organizationId: string | null;
    credentialGeneration: number;
    disabled: boolean;
    betaAdmission: BetaAdmissionEpoch | null;
  } | null> {
    const row = await this.env.DB.prepare(
      `SELECT host.scope, host.organization_id,
              host.credential_generation,
              (host.disabled OR (host.scope = 'organization' AND (host.role <> 'agent'
                OR NOT (${organizationHostAdmissionCondition()})))) AS disabled,
              CASE WHEN access.state = 'active' THEN access.source_invite_id END AS beta_source_invite_id,
              CASE WHEN access.state = 'active' THEN access.source_lease_id END AS beta_source_lease_id,
              CASE WHEN access.state = 'active' THEN access.granted_at END AS beta_granted_at
       FROM agent_hosts host
       LEFT JOIN access_allowlist access ON access.user_id = host.user_id
       WHERE host.id = ?1
       LIMIT 1`,
    )
      .bind(hostId)
      .first<{
        scope: "personal" | "platform" | "organization" | null;
        organization_id: string | null;
        credential_generation: number;
        disabled: number;
        beta_source_invite_id: string | null;
        beta_source_lease_id: string | null;
        beta_granted_at: number | null;
      }>();
    return row
      ? {
          scope: row.scope,
          organizationId: row.organization_id,
          credentialGeneration: row.credential_generation,
          disabled: row.disabled !== 0,
          betaAdmission: admissionFromDatabaseRow(row),
        }
      : null;
  }

  private async rejectClientHelloAdmission(
    ws: WebSocket,
    hostId: string,
    reason: string,
  ): Promise<void> {
    const admission = await this.loadHostConnectionAdmission(hostId);
    if (
      !admission ||
      !admission.scope ||
      admission.credentialGeneration < 1 ||
      admission.disabled ||
      (admission.scope === "personal" && admission.betaAdmission === null)
    ) {
      await this.retireRuntimeState(hostId, reason);
      return;
    }
    try {
      ws.close(1008, reason);
    } catch {
      // The rejected socket may already be closing.
    }
  }

  private async isCurrentHostSessionAdmission(
    hostId: string,
    sessionId: string,
    betaAdmission: BetaAdmissionEpoch | null,
    credentialGeneration: number,
    organizationId: string | null | undefined,
  ): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT 1 AS admitted
       FROM agent_hosts host
       LEFT JOIN access_allowlist access ON access.user_id = host.user_id
       WHERE host.id = ?1
         AND host.active_session_id = ?2
         AND host.credential_generation = ?6
         AND host.credential_generation > 0
         AND host.disabled = 0
         AND (
           (
             ((host.scope = 'platform' AND ?7 IS NULL) OR (host.scope = 'organization' AND host.role = 'agent' AND host.organization_id = ?7
               AND (${organizationHostAdmissionCondition()})))
             AND ?3 IS NULL
             AND ?4 IS NULL
             AND ?5 IS NULL
           )
           OR (
             host.scope = 'personal' AND ?7 IS NULL
             AND access.state = 'active'
             AND access.source_invite_id = ?3
             AND access.source_lease_id = ?4
             AND access.granted_at = ?5
           )
         )
       LIMIT 1`,
    )
      .bind(
        hostId,
        sessionId,
        betaAdmission?.sourceInviteId ?? null,
        betaAdmission?.sourceLeaseId ?? null,
        betaAdmission?.grantedAt ?? null,
        credentialGeneration,
        organizationId ?? null,
      )
      .first<{ admitted: number }>();
    return row?.admitted === 1;
  }

  private async retireRuntimeState(
    hostId: string,
    reason: string,
    closeCode = 1008,
  ): Promise<void> {
    const relayCleanup = (async () => {
      const identity = await drizzle(this.env.DB).select({ generation: agentHosts.credentialGeneration, disabled: agentHosts.disabled, scope: agentHosts.scope })
        .from(agentHosts).where(eq(agentHosts.id, hostId)).get();
      // The durable credential fence has already advanced on removal. Revoke only old generations.
      if (identity?.scope === "personal" || identity?.scope === "organization") await revokeStargateHostRelayCredentials({ hostId,
        credentialGeneration: Math.max(0, identity.generation - (identity.disabled ? 1 : 0)) });
    })();
    // Observe failure immediately; close control sockets even if Stargate is unavailable.
    const relayResult = relayCleanup.then(() => null, (error: unknown) => error);
    let stopState: HostDesiredStateV2 | undefined;
    let stopReadFailed = false;
    try {
      // Persist a new desired version so an agent can accept the final stop.
      // Retain VM identities and leases as evidence for physical cleanup.
      const [retained] = await drizzle(this.env.DB)
        .select({ version: hostDesiredState.version, state: hostDesiredState.docJson })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, hostId));
      if (retained) stopState = await mutateStoredHostDesiredState(drizzle(this.env.DB), hostId, Date.now(), draft => {
        draft.cached_images = [];
        draft.cached_guest_tools = [];
        draft.builds = [];
        for (const vm of draft.vms) vm.desired_phase = "absent";
      }, retained.state);
    } catch (error) {
      stopReadFailed = true;
      // A failed read must not keep a revoked socket connected.
      console.warn(JSON.stringify({
        message: "failed to load host retirement stop state", hostId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    const sockets = hostId
      ? [
          ...this.ctx.getWebSockets(`host:${hostId}`),
          ...this.ctx.getWebSockets(`run-status-host:${hostId}`),
        ]
      : this.ctx.getWebSockets();
    for (const socket of sockets) {
      try {
        const attachment = this.readSocketAttachment(socket);
        if (
          stopState && socket.readyState === WebSocket.OPEN && attachment?.hostId === hostId &&
          attachment.helloReceived && attachment.bridgeProtocol === "v6"
        ) {
          socket.send(serializeBridgeMessageV8({
            type: "desired_state", protocol_version: 8, host_id: hostId, relay: null,
            desired_state: stopState,
          }));
        }
      } catch {
        // Delivery is best effort; never wait for a revoked host's report.
      }
      try {
        socket.close(closeCode, reason);
      } catch {
        // Retirement is idempotent and the socket may already be closing.
      }
    }
    const now = Date.now();
    const retired = await this.env.DB.prepare(
      `UPDATE agent_hosts
       SET connected = 0,
           active_session_id = NULL,
           disconnected_at = coalesce(disconnected_at, ?2),
           updated_at = ?2
       WHERE id = ?1`,
    )
      .bind(hostId, now)
      .run();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.knownHostId = null;
    // The coordinated release already ended every lease in D1. Do not
    // recreate desired state, recovery work, or an alarm under maintenance.
    if (controlPlaneMaintenanceEnabled(this.env)) {
      const relayError = await relayResult;
      if (relayError) throw relayError;
      if (stopReadFailed) throw new Error("host retirement stop state could not be read");
      return;
    }
    if (retired.meta.changes > 0) {
      // A caller can time out while this operation is still running. Restore
      // lease cleanup here; a concurrent caller's earlier wake can be erased
      // by deleteAll. Keep only the identity and the normal alarm metadata.
      await this.persistKnownHostId(hostId);
      try {
        await this.scheduleNextAlarm(hostId);
      } catch (error) {
        // D1 failure must not strand retained leases after storage was reset.
        await this.scheduleAlarmNoLaterThan(Date.now() + RUNTIME_LEASE_CLEANUP_RETRY_MS);
        throw error;
      }
    }
    const relayError = await relayResult;
    if (relayError) throw relayError;
    if (stopReadFailed) throw new Error("host retirement stop state could not be read");
  }

  private async reconcileScenarioImageCacheIfDue(input: {
    db: DrizzleD1Database;
    hostId: string;
    architecture: HostCapabilitiesV2["arch"];
    expectedSessionId: string;
    nowUnixMs: number;
  }): Promise<void> {
    const nextReconciliationAt =
      this.nextScenarioImageCacheReconciliationAtMs ??
      (await this.ctx.storage.get<number>(
        SCENARIO_IMAGE_CACHE_NEXT_RECONCILIATION_STORAGE_KEY,
      )) ??
      0;
    this.nextScenarioImageCacheReconciliationAtMs = nextReconciliationAt;
    if (input.nowUnixMs < nextReconciliationAt) {
      return;
    }

    const result = await reconcileHostScenarioImages(input.db, {
      hostId: input.hostId,
      architecture: input.architecture,
      nowUnixMs: input.nowUnixMs,
      expectedActiveSessionId: input.expectedSessionId,
    });
    if (result.outcome !== "stale_host_snapshot") {
      const nextAt =
        input.nowUnixMs + SCENARIO_IMAGE_CACHE_RECONCILIATION_INTERVAL_MS;
      await this.ctx.storage.put(
        SCENARIO_IMAGE_CACHE_NEXT_RECONCILIATION_STORAGE_KEY,
        nextAt,
      );
      this.nextScenarioImageCacheReconciliationAtMs = nextAt;
    }
  }
}

function parseRunStatusStreamAttachment(
  headers: Headers,
): Omit<RunStatusSocketAttachment, "expiresAt"> | null {
  const runId = requiredRunStatusHeader(headers, "x-run-status-run-id", 240);
  const userId = requiredRunStatusHeader(headers, "x-run-status-user-id");
  const hostId = requiredRunStatusHeader(
    headers,
    "x-run-status-host-id",
    240,
  );
  const sessionId = requiredRunStatusHeader(
    headers,
    "x-run-status-session-id",
  );
  const betaSourceInviteId = headers.get(
    "x-run-status-beta-source-invite-id",
  );
  const betaSourceLeaseId = headers.get(
    "x-run-status-beta-source-lease-id",
  );
  const betaAdmissionGrantedAt = parseRunStatusTimestamp(
    headers.get("x-run-status-beta-admission-granted-at"),
  );
  if (
    !runId ||
    !userId ||
    !hostId ||
    !sessionId ||
    !validAdmissionId(betaSourceInviteId) ||
    !validAdmissionId(betaSourceLeaseId) ||
    betaAdmissionGrantedAt === null
  ) {
    return null;
  }
  return {
    kind: "run-status",
    runId,
    userId,
    hostId,
    sessionId,
    betaSourceInviteId,
    betaSourceLeaseId,
    betaAdmissionGrantedAt,
  };
}

function requiredRunStatusHeader(
  headers: Headers,
  name: string,
  maxLength = 256,
): string | null {
  const value = headers.get(name);
  return value !== null &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
    ? value
    : null;
}

function parseRunStatusTimestamp(value: string | null): number | null {
  if (!value || !/^\d{1,16}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseBetaAdmissionHeaders(headers: Headers):
  | { valid: true; admission: BetaAdmissionEpoch | null }
  | { valid: false } {
  const sourceInviteId = headers.get("x-agent-beta-source-invite-id");
  const sourceLeaseId = headers.get("x-agent-beta-source-lease-id");
  const grantedAtValue = headers.get("x-agent-beta-admission-granted-at");
  if (
    sourceInviteId === null &&
    sourceLeaseId === null &&
    grantedAtValue === null
  ) {
    return { valid: true, admission: null };
  }
  if (
    !validAdmissionId(sourceInviteId) ||
    !validAdmissionId(sourceLeaseId) ||
    !grantedAtValue ||
    !/^\d{1,16}$/u.test(grantedAtValue)
  ) {
    return { valid: false };
  }
  const grantedAt = Number(grantedAtValue);
  if (!Number.isSafeInteger(grantedAt) || grantedAt < 0) {
    return { valid: false };
  }
  return {
    valid: true,
    admission: { sourceInviteId, sourceLeaseId, grantedAt },
  };
}

function validAdmissionId(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
  );
}

function sameBetaAdmission(
  left: BetaAdmissionEpoch | null,
  right: BetaAdmissionEpoch | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.sourceInviteId === right.sourceInviteId &&
    left.sourceLeaseId === right.sourceLeaseId &&
    left.grantedAt === right.grantedAt
  );
}

function betaAdmissionFromAttachment(
  attachment: SocketAttachment,
): BetaAdmissionEpoch | null {
  return admissionFromValues(
    attachment.betaSourceInviteId,
    attachment.betaSourceLeaseId,
    attachment.betaAdmissionGrantedAt,
  );
}

function admissionFromDatabaseRow(row: {
  beta_source_invite_id: string | null;
  beta_source_lease_id: string | null;
  beta_granted_at: number | null;
}): BetaAdmissionEpoch | null {
  return admissionFromValues(
    row.beta_source_invite_id,
    row.beta_source_lease_id,
    row.beta_granted_at,
  );
}

function admissionFromValues(
  sourceInviteId: string | null,
  sourceLeaseId: string | null,
  grantedAt: number | null,
): BetaAdmissionEpoch | null {
  return validAdmissionId(sourceInviteId) &&
    validAdmissionId(sourceLeaseId) &&
    typeof grantedAt === "number" &&
    Number.isSafeInteger(grantedAt) &&
    grantedAt >= 0
    ? { sourceInviteId, sourceLeaseId, grantedAt }
    : null;
}

function runtimeActualStateFromReport(report: VmReportV2): VmActualStateV2 {
  return {
    owner_user_id: report.owner_user_id,
    runtime_execution_id: report.runtime_execution_id,
    generation: report.generation,
    run_id: report.run_id,
    vm_name: report.vm_name,
    phase: report.phase,
    terminal: report.terminal,
    ssh_host_keys_openssh: report.ssh_host_keys_openssh,
    probes: report.probes,
    updated_at_unix_ms: report.observed_at_unix_ms,
    ...(report.desired_version !== undefined
      ? { desired_version: report.desired_version }
      : {}),
    ...(report.network !== undefined ? { network: report.network } : {}),
    ...(report.runtime_constraints !== undefined
      ? { runtime_constraints: report.runtime_constraints }
      : {}),
    ...(report.resource_state !== undefined
      ? { resource_state: report.resource_state }
      : {}),
    ...(report.sandbox !== undefined ? { sandbox: report.sandbox } : {}),
    ...(report.archive !== undefined ? { archive: report.archive } : {}),
    ...(report.error !== undefined ? { error: report.error } : {}),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

/**
 * Classifies a terminal attach failure without exposing the error text. The
 * gateway status is the only detail that leaves this module, because an error
 * body can echo request fields and the request carries guest credentials.
 */
function attachFailureCode(error: unknown): string {
  if (error instanceof StargateTerminalAttachError) {
    return "gateway_" + String(error.status);
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "unknown";
}
