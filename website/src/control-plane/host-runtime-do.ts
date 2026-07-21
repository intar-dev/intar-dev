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
import {
  agentHosts,
  hostActualState,
  hostResourceReservations,
  type RuntimeExecutionState,
  type WorkshopCurrentHealth,
  type WorkshopManifestV1,
  type WorkshopWorkspaceGenerationState,
} from "@/db/schema";
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
  archiveRuntimeExecution,
  updateRuntimeExecutionState,
} from "@/lib/runtime-executions";
import { expireOverdueRuntimeExecutions } from "@/lib/runtime-lease-expiry";
import { recordRuntimeVmActualState } from "@/lib/runtime-vm-state";
import {
  isReportedHostRoleAllowed,
  resolveScenarioEnabledForHostRole,
} from "@/lib/scenario-hosts";
import type {
  BridgeMessageV6,
  HostDesiredStateV2,
  HostStateReportV2,
  VmActualStateV2,
  VmProbeSnapshotV1,
  VmReportV2,
} from "@/generated/bridge";
import { recordWorkshopModuleObservation } from "@/lib/workshops/progress";
import { recordWorkshopGenerationState } from "@/lib/workshops/provisioning";
import { recoverWorkshopRuntimesFromFailedHost } from "@/lib/workshops/runtime-orchestrator";

export const WORKSHOP_HOST_FAILURE_RECOVERY_AFTER_MS = 90_000;
export const WORKSHOP_HOST_FAILURE_RECOVERY_BATCH_SIZE = 8;

type RuntimeVmReportContext = {
  executionId: string;
  userId: string;
  organizationId: string | null;
  hostId: string;
  domainKind: "scenario" | "workshop";
  domainId: string;
  generation: number;
  state: RuntimeExecutionState;
  archiveRequestedAt: number | null;
  runtimeVmId: string;
  vmId: string;
  runtimeVmName: string;
};

type CurrentWorkshopRuntimeContext = {
  generationId: string;
  workspaceId: string;
  sessionId: string;
  participantUserId: string;
  manifest: WorkshopManifestV1;
};

type RuntimeVmAggregateRow = {
  vmId: string;
  terminalHost: string | null;
  phase: VmActualStateV2["phase"] | null;
  report: VmActualStateV2 | null;
  observedAt: number | null;
};

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

    await this.reconcileHost(hostId, {
      recoverUnavailableWorkshopRuntimes: true,
    });
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
    await this.applyRuntimeInventoryReport(hostId, report, expectedSessionId);
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
      if (run?.hostId === hostId) {
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
            expectedHostSession: {
              hostId,
              activeSessionId: expectedSessionId,
            },
          },
        );
      }

      if (projectionOutcome !== "stale_session") {
        try {
          await this.applyRuntimeVmActualState(
            hostId,
            runtimeActualStateFromReport(report),
            report.observed_at_unix_ms,
            expectedSessionId,
          );
        } catch (error) {
          // Scenario projection remains authoritative during the shared-runtime
          // migration. A missing mirror credential must not regress its
          // established lifecycle; workshop errors remain observable and are
          // retried by the agent's next report.
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

  private async applyRuntimeInventoryReport(
    hostId: string,
    report: HostStateReportV2,
    expectedSessionId: string,
  ): Promise<void> {
    for (const actual of report.vms) {
      await this.withRunProjectionLock(actual.run_id, async () => {
        try {
          await this.applyRuntimeVmActualState(
            hostId,
            actual,
            actual.updated_at_unix_ms,
            expectedSessionId,
            { workshopsOnly: true },
          );
        } catch (error) {
          logRuntimeProjectionFailure(hostId, actual, error);
        }
      });
    }

    const desired = await loadOrCreateHostDesiredState(
      drizzle(this.env.DB),
      hostId,
      Date.now(),
    );
    if (report.applied_desired_version < desired.version) return;

    const reported = new Set(
      report.vms.map((vm) => runtimeVmIdentity(vm.run_id, vm.vm_name)),
    );
    for (const expected of desired.vms) {
      if (
        expected.desired_phase !== "running" ||
        reported.has(runtimeVmIdentity(expected.run_id, expected.vm_name))
      ) {
        continue;
      }
      const missing = missingRuntimeVmActualState(
        expected.run_id,
        expected.vm_name,
        report.observed_at_unix_ms,
        report.applied_desired_version,
      );
      await this.withRunProjectionLock(expected.run_id, async () => {
        try {
          await this.applyRuntimeVmActualState(
            hostId,
            missing,
            report.observed_at_unix_ms,
            expectedSessionId,
            { workshopsOnly: true },
          );
        } catch (error) {
          logRuntimeProjectionFailure(hostId, missing, error);
        }
      });
    }
  }

  private async applyRuntimeVmActualState(
    hostId: string,
    report: VmActualStateV2,
    observedAt: number,
    expectedSessionId: string,
    options: { workshopsOnly?: boolean } = {},
  ): Promise<void> {
    const context = await this.loadRuntimeVmReportContext(
      hostId,
      report.run_id,
      report.vm_name,
    );
    if (!context) return;
    if (options.workshopsOnly && context.domainKind !== "workshop") return;
    if (
      context.domainKind === "workshop" &&
      (context.state === "archived" || context.state === "failed")
    ) {
      return;
    }

    const workshop =
      context.domainKind === "workshop"
        ? await this.loadCurrentWorkshopRuntimeContext(context)
        : null;
    if (context.domainKind === "workshop" && !workshop) return;

    const outcome = await recordRuntimeVmActualState({
      executionId: context.executionId,
      expectedGeneration: context.generation,
      vmId: context.vmId,
      hostId,
      report,
      observedAt,
      expectedHostSessionId: expectedSessionId,
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

    // Scenario lifecycle remains projected by persistRunState above. The
    // generic mirror intentionally stops here until every scenario start has
    // runtime access credentials.
    if (!workshop) return;
    if (
      !(await this.isActiveHostSession({
        hostId,
        activeSessionId: expectedSessionId,
      }))
    ) {
      return;
    }
    const currentWorkshop =
      await this.loadCurrentWorkshopRuntimeContext(context);
    if (
      !currentWorkshop ||
      currentWorkshop.generationId !== workshop.generationId
    ) {
      return;
    }

    const actual = await this.loadRuntimeVmAggregate(context.executionId);
    const aggregateObservedAt = actual.reduce(
      (latest, vm) => Math.max(latest, vm.observedAt ?? 0),
      now,
    );
    const aggregate = aggregateRuntimeExecutionState({
      currentState: context.state,
      archiveRequestedAt: context.archiveRequestedAt,
      actual,
    });
    try {
      if (aggregate.state === "archived") {
        await archiveRuntimeExecution({
          executionId: context.executionId,
          expectedGeneration: context.generation,
          endedAt: aggregateObservedAt,
        });
      } else {
        await updateRuntimeExecutionState({
          executionId: context.executionId,
          expectedGeneration: context.generation,
          state: aggregate.state,
          observedAt: aggregateObservedAt,
        });
      }
    } catch {
      // A checkpoint restore can install a newer execution while this report
      // is being aggregated. The current-generation guard is authoritative.
      return;
    }

    await recordWorkshopGenerationState({
      generationId: currentWorkshop.generationId,
      update: {
        state: runtimeStateToWorkshopGenerationState(aggregate.state),
        runtimeExecutionId: context.executionId,
        hostId,
        error: aggregate.error,
        observedAt: aggregateObservedAt,
      },
    });
    await this.projectWorkshopProbeProgress(
      currentWorkshop,
      actual,
      aggregateObservedAt,
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
        domain_kind: "scenario" | "workshop";
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

  private async loadCurrentWorkshopRuntimeContext(
    runtime: RuntimeVmReportContext,
  ): Promise<CurrentWorkshopRuntimeContext | null> {
    const row = await this.env.DB.prepare(
      `SELECT
         generation.id AS generation_id,
         workspace.id AS workspace_id,
         workspace.session_id,
         workspace.user_id AS participant_user_id,
         revision.manifest_json
       FROM workshop_workspace_generations generation
       INNER JOIN workshop_workspaces workspace
         ON workspace.id = generation.workspace_id
        AND workspace.current_generation_id = generation.id
       INNER JOIN workshop_sessions session ON session.id = workspace.session_id
       INNER JOIN workshop_template_revisions revision
         ON revision.id = session.template_revision_id
       WHERE generation.runtime_execution_id = ?
         AND generation.ordinal = ?
         AND generation.host_id = ?
         AND workspace.id = ?
         AND workspace.user_id = ?
         AND session.state IN ('lobby', 'live')
       LIMIT 1`,
    )
      .bind(
        runtime.executionId,
        runtime.generation,
        runtime.hostId,
        runtime.domainId,
        runtime.userId,
      )
      .first<{
        generation_id: string;
        workspace_id: string;
        session_id: string;
        participant_user_id: string;
        manifest_json: string;
      }>();
    if (!row) return null;
    return {
      generationId: row.generation_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      participantUserId: row.participant_user_id,
      manifest: JSON.parse(row.manifest_json) as WorkshopManifestV1,
    };
  }

  private async loadRuntimeVmAggregate(
    executionId: string,
  ): Promise<RuntimeVmAggregateRow[]> {
    const rows = await this.env.DB.prepare(
      `SELECT
         vm.vm_id,
         vm.terminal_host,
         actual.phase,
         actual.report_json,
         actual.observed_at
       FROM runtime_vms vm
       LEFT JOIN runtime_vm_actual_state actual
         ON actual.runtime_vm_id = vm.id
        AND actual.execution_id = vm.execution_id
       WHERE vm.execution_id = ?
       ORDER BY vm.ordinal ASC`,
    )
      .bind(executionId)
      .all<{
        vm_id: string;
        terminal_host: string | null;
        phase: VmActualStateV2["phase"] | null;
        report_json: string | null;
        observed_at: number | null;
      }>();
    return rows.results.map((row) => ({
      vmId: row.vm_id,
      terminalHost: row.terminal_host,
      phase: row.phase,
      report: row.report_json
        ? (JSON.parse(row.report_json) as VmActualStateV2)
        : null,
      observedAt: row.observed_at,
    }));
  }

  private async projectWorkshopProbeProgress(
    workshop: CurrentWorkshopRuntimeContext,
    actual: RuntimeVmAggregateRow[],
    observedAt: number,
  ): Promise<void> {
    const snapshots = latestProbeSnapshots(actual);
    const progressRows = await this.env.DB.prepare(
      `SELECT module_id, technical_status, current_health
       FROM workshop_module_progress
       WHERE session_id = ? AND user_id = ?`,
    )
      .bind(workshop.sessionId, workshop.participantUserId)
      .all<{
        module_id: string;
        technical_status: string;
        current_health: WorkshopCurrentHealth;
      }>();
    const current = new Map(
      progressRows.results.map((row) => [row.module_id, row]),
    );
    for (const module of workshop.manifest.modules) {
      if (module.probeIds.length === 0) continue;
      const probes = module.probeIds.map((probeId) => snapshots.get(probeId));
      const allPassing =
        probes.length > 0 && probes.every((probe) => probe?.status === "pass");
      const currentHealth: WorkshopCurrentHealth = allPassing
        ? "passing"
        : probes.some((probe) => probe?.status === "fail")
          ? "failing"
          : "unknown";
      const existing = current.get(module.id);
      if (
        existing?.current_health === currentHealth &&
        (!allPassing || existing.technical_status === "verified")
      ) {
        continue;
      }
      await recordWorkshopModuleObservation({
        sessionId: workshop.sessionId,
        participantUserId: workshop.participantUserId,
        moduleId: module.id,
        ...(allPassing ? { technicalStatus: "verified" as const } : {}),
        currentHealth,
        observedAt,
      });
    }
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
    options?: {
      reconcileCpuReservations?: boolean;
      recoverUnavailableWorkshopRuntimes?: boolean;
    },
  ): Promise<void> {
    const now = Date.now();
    const db = drizzle(this.env.DB);
    await maintainHostBuildAssignments(db, hostId, now);
    await expireOverdueRunLeases(hostId, now, {
      db,
      wakeHostRuntime: false,
    });
    await expireOverdueRuntimeExecutions(hostId, now);
    if (options?.reconcileCpuReservations !== false) {
      await this.withCpuReservationLock(async () => {
        await reconcileHostCpuReservations(db, hostId, now);
      });
    }

    const activeSocket = await this.findActiveSocket(hostId);
    if (options?.recoverUnavailableWorkshopRuntimes && !activeSocket) {
      const host = await this.loadRequiredHost(hostId);
      if (workshopHostFailureRecoveryIsDue(host, now)) {
        await recoverWorkshopRuntimesFromFailedHost({
          hostId,
          now,
          maxWorkspaces: WORKSHOP_HOST_FAILURE_RECOVERY_BATCH_SIZE,
        });
      }
    }
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

function workshopHostFailureRecoveryIsDue(
  host: Pick<
    typeof agentHosts.$inferSelect,
    "disconnectedAt" | "lastHeartbeatAt"
  >,
  now: number,
): boolean {
  const unavailableSince = host.disconnectedAt ?? host.lastHeartbeatAt;
  return (
    unavailableSince !== null &&
    now - unavailableSince >= WORKSHOP_HOST_FAILURE_RECOVERY_AFTER_MS
  );
}

function runtimeActualStateFromReport(report: VmReportV2): VmActualStateV2 {
  return {
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

function missingRuntimeVmActualState(
  executionId: string,
  runtimeVmName: string,
  observedAt: number,
  desiredVersion: number,
): VmActualStateV2 {
  const reason = "VM is missing from the authoritative host inventory";
  return {
    run_id: executionId,
    vm_name: runtimeVmName,
    desired_version: desiredVersion,
    phase: "absent",
    terminal: {
      state: "failed",
      reason,
      observed_at_unix_ms: observedAt,
    },
    ssh_host_keys_openssh: [],
    probes: [],
    error: reason,
    updated_at_unix_ms: observedAt,
  };
}

function runtimeVmIdentity(executionId: string, runtimeVmName: string): string {
  return `${executionId}\0${runtimeVmName}`;
}

function logRuntimeProjectionFailure(
  hostId: string,
  report: Pick<VmActualStateV2, "run_id" | "vm_name">,
  error: unknown,
): void {
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

function aggregateRuntimeExecutionState(input: {
  currentState: RuntimeExecutionState;
  archiveRequestedAt: number | null;
  actual: RuntimeVmAggregateRow[];
}): {
  state: RuntimeExecutionState;
  error: string | null;
} {
  const archiving =
    input.archiveRequestedAt !== null || input.currentState === "archiving";
  const allReported =
    input.actual.length > 0 && input.actual.every((vm) => vm.phase !== null);
  if (archiving) {
    const allAbsent =
      allReported &&
      input.actual.every(
        (vm) => vm.phase === "absent" || vm.phase === "stopped",
      );
    return { state: allAbsent ? "archived" : "archiving", error: null };
  }

  const failed = input.actual.find(
    (vm) =>
      vm.phase === "failed" || vm.phase === "absent" || vm.phase === "stopped",
  );
  if (failed) {
    return {
      state: "failed",
      error:
        failed.report?.error?.trim() ||
        `VM ${failed.vmId} reported ${failed.phase}`,
    };
  }

  const ready =
    allReported &&
    input.actual.every(
      (vm) =>
        (vm.phase === "ready" || vm.phase === "solved") &&
        vm.terminalHost !== null,
    );
  return { state: ready ? "ready" : "provisioning", error: null };
}

function runtimeStateToWorkshopGenerationState(
  state: RuntimeExecutionState,
): WorkshopWorkspaceGenerationState {
  return state;
}

function latestProbeSnapshots(
  actual: RuntimeVmAggregateRow[],
): Map<string, VmProbeSnapshotV1> {
  const snapshots = new Map<string, VmProbeSnapshotV1>();
  for (const vm of actual) {
    for (const probe of vm.report?.probes ?? []) {
      const current = snapshots.get(probe.id);
      if (!current || probe.checked_at_unix_ms >= current.checked_at_unix_ms) {
        snapshots.set(probe.id, probe);
      }
    }
  }
  return snapshots;
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
