import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState, scenarioRuns } from "@/db/schema";
import { nextPendingHostCpuReservationExpiry } from "@/control-plane/host-cpu-reservations";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  canAdvanceRunPhase,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import { recordProbeTransitions } from "@/lib/run-probe-history";
import { nextSolvedAt } from "@/lib/scenario-run-outcome";
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";
import { recordLinkedCourseUnitCompletionForRun } from "@/lib/scenario-course-catalogs";
import {
  loadOrCreateHostDesiredState,
  mutateStoredHostDesiredState,
} from "@/lib/desired-state-store";
import { removeDesiredBuild } from "@/lib/desired-state";
import type { HostDesiredStateV2 } from "@/generated/bridge";

export const HOST_BUILD_MAINTENANCE_INTERVAL_MS = 60_000;
export const DESIRED_VERSION_LAG_REPUSH_AFTER_MS = 10_000;
export const RUNTIME_LEASE_CLEANUP_RETRY_MS = 10_000;
export const WORKSHOP_RECOVERY_RETRY_MS = 10_000;

export interface SocketAttachment {
  hostId: string;
  sessionId: string | null;
  /** Exact beta grant carried by a personal-host JWT; null for org hosts. */
  betaSourceInviteId: string | null;
  betaSourceLeaseId: string | null;
  betaAdmissionGrantedAt: number | null;
  connectedAt: number;
  helloReceived: boolean;
  bridgeProtocol: "v6" | null;
  lastDesiredVersionSent: number | null;
  lastDesiredDispatchAtMs: number | null;
}

interface RunProjectionRow {
  runId: string;
  hostId: string;
  activeKey: string | null;
  deleteRequestedAt: number | null;
  solvedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  createdAt: number;
  updatedAt: number;
  state: RunStateDocument;
}

export type RunProjectionOutcome = "updated" | "unchanged" | "stale_session";

export class HostRuntimeBase extends DurableObject<Cloudflare.Env> {
  protected readonly runProjectionQueues = new Map<string, Promise<void>>();
  protected knownHostId: string | null | undefined;

  constructor(
    ctx: DurableObjectState,
    override readonly env: Cloudflare.Env,
  ) {
    super(ctx, env);
  }

  protected async withRunProjectionLock<T>(
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

  protected async persistRunState(
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
        (merged.phase === "completed" || merged.phase === "failed") &&
        deleteRequestedAt === null
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
        if (merged.phase === "completed" && solvedAt !== null) {
          await recordLinkedCourseUnitCompletionForRun(db, {
            runId,
            nowUnixMs: now,
          });
        }
        return "unchanged";
      }

      const expectedHostSession = options?.expectedHostSession;
      const mutation = db
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
          archiveEnteredAt: ["archiving", "completed", "failed"].includes(
            merged.phase,
          )
            ? sql<number>`coalesce(${scenarioRuns.archiveEnteredAt}, ${now})`
            : sql<number | null>`${scenarioRuns.archiveEnteredAt}`,
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
      const [updatedResult] = await executeScenarioRunRuntimeProjection({
        d1: this.env.DB,
        runId,
        statements: [drizzleQueryToD1Statement(this.env.DB, mutation)],
        mode: "update",
      });
      const updated = updatedResult?.results ?? [];
      if (!updated.length) {
        if (
          expectedHostSession &&
          !(await this.isActiveHostSession(expectedHostSession))
        ) {
          return "stale_session";
        }
        continue;
      }

      if (merged.phase === "completed" && solvedAt !== null) {
        await recordLinkedCourseUnitCompletionForRun(db, {
          runId,
          nowUnixMs: now,
        });
      }

      await recordProbeTransitions(db, {
        runId,
        current,
        next: merged,
        observedAt: now,
      });
      if (!current.canOpenTerminal && merged.canOpenTerminal) {
        logLifecycleTiming({
          metric: "accepted_to_terminal_ready",
          runId,
          startedAt: row.createdAt,
          completedAt: now,
        });
      }
      if (
        row.deleteRequestedAt !== null &&
        !allVmsReportedAbsent(current) &&
        allVmsReportedAbsent(merged)
      ) {
        logLifecycleTiming({
          metric: "teardown_requested_to_vm_absent",
          runId,
          startedAt: row.deleteRequestedAt,
          completedAt: latestVmAbsenceAt(merged) ?? now,
        });
      }
      return "updated";
    }
    throw new Error(`run projection CAS did not converge for ${runId}`);
  }

  protected async removeTerminalBuildsFromDesiredState(
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

  protected async scheduleNextAlarm(hostId: string): Promise<void> {
    const next = await this.computeNextAlarm(hostId);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  protected async scheduleAlarmNoLaterThan(timestamp: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > timestamp) {
      await this.ctx.storage.setAlarm(timestamp);
    }
  }

  protected async computeNextAlarm(hostId: string): Promise<number | null> {
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
    const runtimeLease = await this.env.DB.prepare(
      `SELECT min(execution.lease_expires_at) AS expires_at
       FROM runtime_executions execution
       WHERE execution.host_id = ?
         AND execution.lease_expires_at IS NOT NULL
         AND execution.state <> 'archived'
         AND NOT EXISTS (
           SELECT 1
           FROM runtime_executions newer
           WHERE newer.domain_kind = execution.domain_kind
             AND newer.domain_id = execution.domain_id
             AND newer.generation > execution.generation
         )`,
    )
      .bind(hostId)
      .first<{ expires_at: number | null }>();
    const nextRuntimeLeaseExpiry = runtimeLease?.expires_at ?? undefined;
    const nextReservationExpiry = await nextPendingHostCpuReservationExpiry(
      drizzle(this.env.DB),
      hostId,
    );
    const pendingWorkshopRecovery = await this.env.DB.prepare(
      `SELECT 1 AS pending
       FROM workshop_workspaces workspace
       INNER JOIN workshop_workspace_generations generation
         ON generation.id = workspace.current_generation_id
       INNER JOIN workshop_sessions session ON session.id = workspace.session_id
       WHERE session.state IN ('lobby', 'live')
         AND workspace.state IN ('recovering', 'failed')
         AND generation.state IN ('queued', 'failed')
         AND EXISTS (
           SELECT 1
           FROM workshop_events event
           WHERE event.session_id = workspace.session_id
             AND event.type = 'workspace.host_failure_recovery_requested'
             AND json_extract(event.payload_json, '$.generationId') = generation.id
             AND json_extract(event.payload_json, '$.failedHostId') = ?
         )
       LIMIT 1`,
    )
      .bind(hostId)
      .first<{ pending: number }>();

    if (
      !activeSocket &&
      !undeliveredDesired &&
      typeof nextLeaseExpiry !== "number" &&
      typeof nextRuntimeLeaseExpiry !== "number" &&
      typeof nextReservationExpiry !== "number" &&
      !pendingWorkshopRecovery &&
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
    if (typeof nextRuntimeLeaseExpiry === "number") {
      candidates.push(
        nextRuntimeLeaseExpiry <= now
          ? now + RUNTIME_LEASE_CLEANUP_RETRY_MS
          : nextRuntimeLeaseExpiry + 1,
      );
    }
    if (typeof nextReservationExpiry === "number") {
      candidates.push(Math.max(now + 1, nextReservationExpiry + 1));
    }
    if (pendingWorkshopRecovery) {
      candidates.push(now + WORKSHOP_RECOVERY_RETRY_MS);
    }
    if (lag.lagging && activeSocket) {
      candidates.push(now + DESIRED_VERSION_LAG_REPUSH_AFTER_MS);
    }
    return Math.min(...candidates);
  }

  protected async handleSocketClosed(ws: WebSocket): Promise<void> {
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

  protected async closeOlderSockets(
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

  protected async findActiveSocket(
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

  protected async isActiveHostSession(input: {
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

  protected readSocketAttachment(ws: WebSocket): SocketAttachment | null {
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
        betaSourceInviteId:
          typeof parsed.betaSourceInviteId === "string" &&
          parsed.betaSourceInviteId.length > 0 &&
          parsed.betaSourceInviteId.length <= 256
            ? parsed.betaSourceInviteId
            : null,
        betaSourceLeaseId:
          typeof parsed.betaSourceLeaseId === "string" &&
          parsed.betaSourceLeaseId.length > 0 &&
          parsed.betaSourceLeaseId.length <= 256
            ? parsed.betaSourceLeaseId
            : null,
        betaAdmissionGrantedAt:
          typeof parsed.betaAdmissionGrantedAt === "number" &&
          Number.isSafeInteger(parsed.betaAdmissionGrantedAt) &&
          parsed.betaAdmissionGrantedAt >= 0
            ? parsed.betaAdmissionGrantedAt
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

  protected async loadDesiredVersionLag(
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

  protected async loadKnownHostId(): Promise<string | null> {
    if (this.knownHostId !== undefined) {
      return this.knownHostId;
    }
    const value = await this.ctx.storage.get<string>("hostId");
    this.knownHostId =
      typeof value === "string" && value.trim() ? value.trim() : null;
    return this.knownHostId;
  }

  protected async persistKnownHostId(hostId: string): Promise<void> {
    if (this.knownHostId === hostId) {
      return;
    }
    await this.ctx.storage.put("hostId", hostId);
    this.knownHostId = hostId;
  }

  protected async resolveKnownHostId(request: Request): Promise<string | null> {
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

  protected async loadRequiredHost(hostId: string) {
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

  protected async updateHostRow(
    hostId: string,
    values: Partial<typeof agentHosts.$inferInsert>,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    await db.update(agentHosts).set(values).where(eq(agentHosts.id, hostId));
  }

  protected async loadRun(runId: string): Promise<{
    runId: string;
    hostId: string;
    activeKey: string | null;
    deleteRequestedAt: number | null;
    solvedAt: number | null;
    completedAt: number | null;
    failedAt: number | null;
    createdAt: number;
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
        createdAt: scenarioRuns.createdAt,
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      state: parseRunState(row.stateJson),
    };
  }

  protected async listOpenRunsForHost(hostId: string): Promise<
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

function allVmsReportedAbsent(state: RunStateDocument): boolean {
  return (
    state.vms.length > 0 &&
    state.vms.every((vm) => vm.runtimeState === "absent")
  );
}

function latestVmAbsenceAt(state: RunStateDocument): number | null {
  const observed = state.vms
    .filter((vm) => vm.runtimeState === "absent")
    .map((vm) => vm.runtimeObservedAt)
    .filter((value): value is number => value !== null);
  return observed.length ? Math.max(...observed) : null;
}

function logLifecycleTiming(input: {
  metric: "accepted_to_terminal_ready" | "teardown_requested_to_vm_absent";
  runId: string;
  startedAt: number;
  completedAt: number;
}) {
  console.log(
    JSON.stringify({
      event: "scenario_run_lifecycle_timing",
      metric: input.metric,
      runId: input.runId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: Math.max(0, input.completedAt - input.startedAt),
    }),
  );
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}
