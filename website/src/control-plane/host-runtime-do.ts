import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  parseBridgeMessageV6,
  serializeBridgeMessageV6,
} from "@/control-plane/bridge-v6";
import { agentHosts, hostActualState, scenarioRuns } from "@/db/schema";
import {
  acquireHostBenchmarkLeaseAndReserveCpuInD1,
  clearDrainedHostBenchmarkLeaseInD1,
  MAX_BOOT_BENCHMARK_CREDENTIAL_TTL_MS,
  releaseHostBenchmarkLeaseInD1,
} from "@/control-plane/host-benchmark-leases";
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
import type { RequiredScenarioImage } from "@/lib/scenario-host-readiness";
import type {
  BridgeMessageV6,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";

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

interface BridgeReceiptTiming {
  receivedAtUnixMs: number;
  receivedAtPerformanceMs: number;
}

interface DesiredDispatchTiming {
  runId: string;
  desiredVersion: number;
  dispatchedAtUnixMs: number;
}

interface RunProjectionRow {
  runId: string;
  hostId: string;
  activeKey: string | null;
  deleteRequestedAt: number | null;
  solvedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  updatedAt: number;
  state: RunStateDocument;
}

type RunProjectionOutcome = "updated" | "unchanged" | "stale_session";

export class HostRuntimeDO extends DurableObject<Cloudflare.Env> {
  private cpuReservationQueue: Promise<void> = Promise.resolve();
  private desiredDispatchQueue: Promise<void> = Promise.resolve();
  private readonly runProjectionQueues = new Map<string, Promise<void>>();
  private knownHostId: string | null | undefined;

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
    // Both values are captured on the Worker before attachment parsing. The
    // epoch timestamp correlates logs, while the same-isolate Performance API
    // delta measures receipt through D1 projection without comparing clocks.
    const receiptTiming: BridgeReceiptTiming = {
      receivedAtUnixMs: Date.now(),
      receivedAtPerformanceMs: performance.now(),
    };
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
      await this.handleBridgeMessageV6(
        ws,
        attachment,
        bridgeMessage,
        receiptTiming,
      );
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
    const benchmarkAcquire = pathname.endsWith("/benchmark-acquire");
    const commit = pathname.endsWith("/commit");
    if (!benchmarkAcquire && !commit) {
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
      if (benchmarkAcquire) {
        if (
          input.steadyCpuMillisByVm === null ||
          input.guestVcpuCountByVm === null ||
          input.userId === null ||
          input.requiredImages === null ||
          input.credentialNotBeforeUnixMs === null ||
          input.credentialExpiresAtUnixMs === null
        ) {
          return jsonResponse(
            {
              error:
                "steadyCpuMillisByVm, guestVcpuCountByVm, userId, requiredImages, and the credential window are required",
            },
            400,
          );
        }
        const result = await acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
          hostId: input.hostId,
          runId: input.runId,
          userId: input.userId,
          steadyCpuMillisByVm: input.steadyCpuMillisByVm,
          guestVcpuCountByVm: input.guestVcpuCountByVm,
          requiredImages: input.requiredImages,
          credentialNotBeforeUnixMs: input.credentialNotBeforeUnixMs,
          credentialExpiresAtUnixMs: input.credentialExpiresAtUnixMs,
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
      if (pathname.endsWith("/benchmark-release")) {
        if (input.userId === null) {
          return jsonResponse({ error: "userId is required" }, 400);
        }
        await reconcileHostCpuReservations(db, input.hostId, now);
        const result = await releaseHostBenchmarkLeaseInD1(db, {
          hostId: input.hostId,
          runId: input.runId,
          userId: input.userId,
          nowUnixMs: now,
        });
        return jsonResponse(result, result.ok ? 200 : 409);
      }
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
        await clearDrainedHostBenchmarkLeaseInD1(db, input.hostId, now);
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
    receiptTiming: BridgeReceiptTiming,
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
        receiptTiming,
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
    const runningRunIds = new Set(
      state.vms
        .filter((vm) => vm.desired_phase === "running")
        .map((vm) => vm.run_id),
    );
    const desiredRunIds = new Set(state.vms.map((vm) => vm.run_id));
    // Capture a conservative dispatch intent before touching durable storage.
    // A newly observed run/version must be durable before the desired state can
    // reach the agent. If persistence fails, the socket send is never attempted.
    // Forced same-version re-pushes retain the first timestamp.
    const dispatchedAtUnixMs = Date.now();
    await Promise.all(
      [...runningRunIds].map(async (runId) => {
        const key = desiredDispatchStorageKey(runId);
        const existing = await this.ctx.storage.get<DesiredDispatchTiming>(key);
        if (existing) return;
        await this.ctx.storage.put(key, {
          runId,
          desiredVersion: state.version,
          dispatchedAtUnixMs,
        } satisfies DesiredDispatchTiming);
      }),
    );

    ws.send(serialized);
    ws.serializeAttachment({
      ...attachment,
      lastDesiredVersionSent: state.version,
      lastDesiredDispatchAtMs: dispatchedAtUnixMs,
    });

    // Dispatch timing is evidence, not a delivery cache. Retain it across
    // readiness and same-version re-pushes, and remove it only after explicit
    // desired-state cleanup has removed the run altogether.
    // Keep cleanup inside the desired-dispatch lock. A background cleanup for
    // version N must never race version N+1 and delete N+1's newly persisted
    // run evidence using the older desired-run set.
    await this.cleanupRetiredDesiredDispatchTimings(desiredRunIds).catch(
      (error) => {
        console.error(
          JSON.stringify({
            message: "desired dispatch timing cleanup failed",
            hostId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    );
  }

  private async cleanupRetiredDesiredDispatchTimings(
    desiredRunIds: ReadonlySet<string>,
  ): Promise<void> {
    const entries = await this.ctx.storage.list<DesiredDispatchTiming>({
      prefix: DESIRED_DISPATCH_STORAGE_PREFIX,
    });
    const retiredKeys = [...entries.entries()]
      .filter(([, timing]) => !desiredRunIds.has(timing.runId))
      .map(([key]) => key);
    if (retiredKeys.length > 0) {
      await this.ctx.storage.delete(retiredKeys);
    }
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
      await clearDrainedHostBenchmarkLeaseInD1(db, hostId, now);
    });
  }

  private async applyBridgeVmReport(
    hostId: string,
    report: Extract<BridgeMessageV6, { type: "vm_report" }>["report"],
    receiptTiming: BridgeReceiptTiming,
    expectedSessionId: string,
  ): Promise<void> {
    const desiredVersion = report.desired_version;
    const dispatchTiming =
      report.terminal.state === "ready" &&
      Number.isSafeInteger(desiredVersion) &&
      desiredVersion !== null &&
      desiredVersion !== undefined &&
      desiredVersion >= 0
        ? await this.ctx.storage.get<DesiredDispatchTiming>(
            desiredDispatchStorageKey(report.run_id),
          )
        : undefined;
    let projectionOutcome: RunProjectionOutcome | null = null;
    let timingOutcome: RunProjectionOutcome | null = null;
    let projectionAckAtUnixMs: number | null = null;
    let receiptToProjectionAckMs: number | null = null;
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
      if (projectionOutcome === "stale_session" || !dispatchTiming) {
        return;
      }

      projectionAckAtUnixMs = Date.now();
      receiptToProjectionAckMs =
        performance.now() - receiptTiming.receivedAtPerformanceMs;
      if (
        !Number.isFinite(receiptToProjectionAckMs) ||
        receiptToProjectionAckMs < 0
      ) {
        return;
      }
      timingOutcome = await this.persistRunState(
        report.run_id,
        (latest) =>
          attachTerminalProjectionAckTiming({
            current: latest,
            report,
            dispatchTiming,
            receivedAtUnixMs: receiptTiming.receivedAtUnixMs,
            projectionAckAtUnixMs: projectionAckAtUnixMs!,
            receiptToProjectionAckMs: receiptToProjectionAckMs!,
          }),
        {
          keepDeleteRequestedAt: true,
          expectedHostSession: { hostId, activeSessionId: expectedSessionId },
        },
      );
    });

    if (
      projectionOutcome === "stale_session" ||
      timingOutcome === "stale_session"
    ) {
      return;
    }

    if (projectionOutcome === "updated" || timingOutcome === "updated") {
      const timingPersistedAtUnixMs = Date.now();
      console.info(
        JSON.stringify({
          message: "bridge vm report projected",
          hostId,
          runId: report.run_id,
          vmName: report.vm_name,
          generation: report.runtime_constraints?.generation ?? null,
          desiredVersion: report.desired_version ?? null,
          observedAtUnixMs: report.observed_at_unix_ms,
          workerReceivedAtUnixMs: receiptTiming.receivedAtUnixMs,
          workerProjectionAckAtUnixMs: projectionAckAtUnixMs,
          receiptToProjectionAckMs,
          timingPersistedAtUnixMs,
          fullReceiptToTimingPersistenceMs:
            performance.now() - receiptTiming.receivedAtPerformanceMs,
          projectionOutcome,
          timingOutcome,
        }),
      );
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
        await clearDrainedHostBenchmarkLeaseInD1(db, hostId, now);
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

  private async withRunProjectionLock<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.runProjectionQueues.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.runProjectionQueues.set(runId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.runProjectionQueues.get(runId) === tail) {
        this.runProjectionQueues.delete(runId);
      }
    }
  }

  private async persistRunState(
    runId: string,
    deriveNextState: (current: RunStateDocument) => RunStateDocument,
    options?: {
      deleteRequestedAt?: number | null;
      keepDeleteRequestedAt?: boolean;
      initialRow?: RunProjectionRow;
      expectedHostSession?: {
        hostId: string;
        activeSessionId: string;
      };
    },
  ): Promise<RunProjectionOutcome> {
    const db = drizzle(this.env.DB);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // The direct VM-report path already loaded this row for its ownership
      // check inside the per-run ordering domain. Reuse it for attempt zero;
      // a failed CAS still reloads authoritative state before retrying.
      const row =
        attempt === 0 && options?.initialRow?.runId === runId
          ? options.initialRow
          : await this.loadRun(runId);
      if (!row) {
        return "unchanged";
      }

      const current = recomputeRunState(row.state);
      const recomputed = recomputeRunState(deriveNextState(current));
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

      // A strictly increasing value doubles as the optimistic projection
      // generation, even when two writes occur in the same millisecond.
      const now = Math.max(Date.now(), row.updatedAt + 1);
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
        return "unchanged";
      }

      const expectedHostSession = options?.expectedHostSession;
      const updated = await db
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
        .where(
          and(
            eq(scenarioRuns.runId, runId),
            eq(scenarioRuns.updatedAt, row.updatedAt),
            ...(expectedHostSession
              ? [
                  exists(
                    db
                      .select({ id: agentHosts.id })
                      .from(agentHosts)
                      .where(
                        and(
                          eq(agentHosts.id, expectedHostSession.hostId),
                          eq(
                            agentHosts.activeSessionId,
                            expectedHostSession.activeSessionId,
                          ),
                        ),
                      ),
                  ),
                ]
              : []),
          ),
        )
        .returning({ runId: scenarioRuns.runId });
      if (!updated.length) {
        if (
          expectedHostSession &&
          !(await this.isActiveHostSession(expectedHostSession))
        ) {
          return "stale_session";
        }
        continue;
      }

      await recordProbeTransitions(db, {
        runId,
        current,
        next: merged,
        observedAt: now,
      });
      return "updated";
    }
    throw new Error(`run projection CAS did not converge for ${runId}`);
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

  private async scheduleAlarmNoLaterThan(timestamp: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > timestamp) {
      await this.ctx.storage.setAlarm(timestamp);
    }
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
    activeSessionId?: string | null,
  ): Promise<{ socket: WebSocket; attachment: SocketAttachment } | null> {
    const expectedActiveSessionId =
      activeSessionId === undefined
        ? (await this.loadRequiredHost(hostId)).activeSessionId
        : activeSessionId;
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
      (expectedActiveSessionId
        ? matches.find(
            (candidate) =>
              candidate.attachment.sessionId === expectedActiveSessionId,
          )
        : null) ??
      matches[0] ??
      null;
    return active;
  }

  private async isActiveHostSession(input: {
    hostId: string;
    activeSessionId: string;
  }): Promise<boolean> {
    const rows = await drizzle(this.env.DB)
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(
        and(
          eq(agentHosts.id, input.hostId),
          eq(agentHosts.activeSessionId, input.activeSessionId),
        ),
      )
      .limit(1);
    return rows.length === 1;
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
  ): Promise<{
    lagging: boolean;
    desiredVersion: number;
    appliedVersion: number | null;
  }> {
    const db = drizzle(this.env.DB);
    const desired =
      desiredState ??
      (await loadOrCreateHostDesiredState(db, hostId, nowUnixMs));
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
    if (this.knownHostId !== undefined) {
      return this.knownHostId;
    }
    const value = await this.ctx.storage.get<string>("hostId");
    this.knownHostId =
      typeof value === "string" && value.trim() ? value.trim() : null;
    return this.knownHostId;
  }

  private async persistKnownHostId(hostId: string): Promise<void> {
    if (this.knownHostId === hostId) {
      return;
    }
    await this.ctx.storage.put("hostId", hostId);
    this.knownHostId = hostId;
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
    updatedAt: number;
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
        updatedAt: scenarioRuns.updatedAt,
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
      updatedAt: row.updatedAt,
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

function desiredDispatchStorageKey(runId: string): string {
  return `${DESIRED_DISPATCH_STORAGE_PREFIX}${encodeURIComponent(runId)}`;
}

const DESIRED_DISPATCH_STORAGE_PREFIX = "desired-dispatch:";

function attachTerminalProjectionAckTiming(input: {
  current: RunStateDocument;
  report: Extract<BridgeMessageV6, { type: "vm_report" }>["report"];
  dispatchTiming: DesiredDispatchTiming;
  receivedAtUnixMs: number;
  projectionAckAtUnixMs: number;
  receiptToProjectionAckMs: number;
}): RunStateDocument {
  const vmIndex = input.current.vms.findIndex(
    (vm) => vm.runtimeVmName === input.report.vm_name,
  );
  const currentVm = input.current.vms[vmIndex];
  if (!currentVm || vmIndex < 0) return input.current;

  const reportedGeneration =
    input.report.runtime_constraints?.generation.trim() || null;
  const projectedGeneration =
    currentVm.runtimeConstraints?.generation?.trim() || null;
  const desiredVersion = input.report.desired_version;
  const hasPersistedTerminalTiming =
    currentVm.workerTerminalReportReceivedAt !== undefined ||
    currentVm.workerTerminalProjectionAckAt !== undefined ||
    currentVm.workerTerminalReceiptToProjectionAckMs !== undefined ||
    currentVm.workerTerminalProjectionGeneration !== undefined ||
    currentVm.workerTerminalDesiredVersion !== undefined;
  if (
    hasPersistedTerminalTiming ||
    input.report.terminal.state !== "ready" ||
    currentVm.terminalPhase !== "ready" ||
    currentVm.runtimeObservedAt !== input.report.observed_at_unix_ms ||
    currentVm.terminalObservedAt !==
      input.report.terminal.observed_at_unix_ms ||
    !reportedGeneration ||
    reportedGeneration !== projectedGeneration ||
    !Number.isSafeInteger(desiredVersion) ||
    desiredVersion === null ||
    desiredVersion === undefined ||
    desiredVersion < 0 ||
    input.dispatchTiming.runId !== input.report.run_id ||
    input.dispatchTiming.desiredVersion !== desiredVersion ||
    !Number.isSafeInteger(input.dispatchTiming.dispatchedAtUnixMs) ||
    input.dispatchTiming.dispatchedAtUnixMs < 0 ||
    input.dispatchTiming.dispatchedAtUnixMs > input.receivedAtUnixMs ||
    input.receivedAtUnixMs > input.projectionAckAtUnixMs ||
    !Number.isFinite(input.receiptToProjectionAckMs) ||
    input.receiptToProjectionAckMs < 0
  ) {
    return input.current;
  }

  const vms = [...input.current.vms];
  vms[vmIndex] = {
    ...currentVm,
    workerDesiredDispatchAt: input.dispatchTiming.dispatchedAtUnixMs,
    workerDesiredDispatchVersion: input.dispatchTiming.desiredVersion,
    workerTerminalReportReceivedAt: input.receivedAtUnixMs,
    workerTerminalProjectionAckAt: input.projectionAckAtUnixMs,
    workerTerminalReceiptToProjectionAckMs: input.receiptToProjectionAckMs,
    workerTerminalProjectionGeneration: projectedGeneration,
    workerTerminalDesiredVersion: desiredVersion,
  };
  return { ...input.current, vms };
}

async function parseCpuReservationRequest(request: Request): Promise<{
  hostId: string;
  runId: string;
  userId: string | null;
  steadyCpuMillisByVm: number[] | null;
  guestVcpuCountByVm: number[] | null;
  requiredImages: RequiredScenarioImage[] | null;
  credentialNotBeforeUnixMs: number | null;
  credentialExpiresAtUnixMs: number | null;
} | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
    const runId = typeof value.runId === "string" ? value.runId.trim() : "";
    const userId = typeof value.userId === "string" ? value.userId.trim() : "";
    const steadyCpuMillisByVm = value.steadyCpuMillisByVm;
    const guestVcpuCountByVm = value.guestVcpuCountByVm;
    const requiredImages = parseRequiredScenarioImages(value.requiredImages);
    const credentialNotBeforeUnixMs = value.credentialNotBeforeUnixMs;
    const credentialExpiresAtUnixMs = value.credentialExpiresAtUnixMs;
    if (
      !hostId ||
      hostId.length > 128 ||
      !runId ||
      runId.length > 128 ||
      (value.userId !== undefined && (!userId || userId.length > 128)) ||
      (steadyCpuMillisByVm !== undefined &&
        (!Array.isArray(steadyCpuMillisByVm) ||
          steadyCpuMillisByVm.length === 0 ||
          steadyCpuMillisByVm.length > 256 ||
          !steadyCpuMillisByVm.every(isReservationCpuMillis))) ||
      (guestVcpuCountByVm !== undefined &&
        (!Array.isArray(guestVcpuCountByVm) ||
          guestVcpuCountByVm.length === 0 ||
          guestVcpuCountByVm.length > 256 ||
          !guestVcpuCountByVm.every(isReservationVcpuCount))) ||
      (Array.isArray(steadyCpuMillisByVm) &&
        Array.isArray(guestVcpuCountByVm) &&
        steadyCpuMillisByVm.length !== guestVcpuCountByVm.length) ||
      (value.requiredImages !== undefined && requiredImages === null) ||
      (credentialNotBeforeUnixMs !== undefined &&
        !isReservationUnixMs(credentialNotBeforeUnixMs)) ||
      (credentialExpiresAtUnixMs !== undefined &&
        !isReservationUnixMs(credentialExpiresAtUnixMs)) ||
      (isReservationUnixMs(credentialNotBeforeUnixMs) &&
        isReservationUnixMs(credentialExpiresAtUnixMs) &&
        (credentialExpiresAtUnixMs <= credentialNotBeforeUnixMs ||
          credentialExpiresAtUnixMs - credentialNotBeforeUnixMs >
            MAX_BOOT_BENCHMARK_CREDENTIAL_TTL_MS))
    ) {
      return null;
    }
    return {
      hostId,
      runId,
      userId: userId || null,
      steadyCpuMillisByVm: Array.isArray(steadyCpuMillisByVm)
        ? (steadyCpuMillisByVm as number[])
        : null,
      guestVcpuCountByVm: Array.isArray(guestVcpuCountByVm)
        ? (guestVcpuCountByVm as number[])
        : null,
      requiredImages,
      credentialNotBeforeUnixMs: isReservationUnixMs(credentialNotBeforeUnixMs)
        ? credentialNotBeforeUnixMs
        : null,
      credentialExpiresAtUnixMs: isReservationUnixMs(credentialExpiresAtUnixMs)
        ? credentialExpiresAtUnixMs
        : null,
    };
  } catch {
    return null;
  }
}

function parseRequiredScenarioImages(
  value: unknown,
): RequiredScenarioImage[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    return null;
  }

  const identities = new Set<string>();
  const requiredImages: RequiredScenarioImage[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const image = candidate as Record<string, unknown>;
    const imageKeyValue = image.imageKey;
    if (!imageKeyValue || typeof imageKeyValue !== "object") {
      return null;
    }
    const imageKey = imageKeyValue as Record<string, unknown>;
    const scenario =
      typeof imageKey.scenario === "string" ? imageKey.scenario.trim() : "";
    const vm = typeof imageKey.vm === "string" ? imageKey.vm.trim() : "";
    const arch = imageKey.arch;
    const imageSha256 =
      typeof image.imageSha256 === "string"
        ? image.imageSha256.toLowerCase()
        : "";
    const identity = `${scenario}:${vm}:${String(arch)}`;
    if (
      !scenario ||
      scenario.length > 128 ||
      !vm ||
      vm.length > 128 ||
      (arch !== "x86_64" && arch !== "aarch64") ||
      !/^[a-f0-9]{64}$/.test(imageSha256) ||
      identities.has(identity)
    ) {
      return null;
    }
    identities.add(identity);
    requiredImages.push({
      imageKey: { scenario, vm, arch },
      imageSha256,
    });
  }
  return requiredImages;
}

function isReservationCpuMillis(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 4_294_967_295
  );
}

function isReservationVcpuCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 256
  );
}

function isReservationUnixMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
