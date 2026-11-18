import { revokeStargateHostRelay } from "@/lib/stargate-relay";
import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState, scenarioRuns, runtimeExecutions } from "@/db/schema";
import { nextPendingHostCpuReservationExpiry } from "@/control-plane/host-cpu-reservations";
import {
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import { RUN_STATUS_PING, RUN_STATUS_PONG } from "@/lib/run-status-heartbeat";
import {
  loadStoredHostDesiredState,
} from "@/lib/desired-state-store";
import type { HostDesiredStateV3 } from "@/generated/contracts/bridge-message-v9";
import {
  loadRunProjection,
  persistRunState,
  type RunProjectionOutcome,
  type RunProjectionRow,
} from "@/lib/run-projection";

export type { RunProjectionOutcome };

export const HOST_BUILD_MAINTENANCE_INTERVAL_MS = 60_000;
export const DESIRED_VERSION_LAG_REPUSH_AFTER_MS = 10_000;
export const RUNTIME_LEASE_CLEANUP_RETRY_MS = 10_000;
export const HOST_HELLO_TIMEOUT_MS = 15_000;
export const MAX_PENDING_HOST_SOCKETS = 4;
export const MAX_STATUS_SOCKETS_PER_USER = 8;
export const MAX_STATUS_SOCKETS = 512;
export const STATUS_SOCKET_LIFETIME_MS = 15 * 60_000;
export const RUNTIME_ALARM_KEY = "runtime-alarm-at-ms";

export interface SocketAttachment {
  kind: "agent";
  hostId: string;
  credentialGeneration: number;
  /** Host scope admitted at connect; every later admission check requires the host to still have it. */
  scope: HostDesiredStateV3["scope"];
  organizationId?: string | null;
  sessionId: string | null;
  connectedAt: number;
  helloReceived: boolean;
  bridgeProtocol: "v9" | null;
  /** The guest contract a bridge 9 hello stated. */
  guestContract?: number | null;
  lastDesiredVersionSent: number | null;
  lastDesiredDispatchAtMs: number | null;
}

/**
 * Browser status listeners deliberately use a different attachment shape from
 * agent bridge sockets. This prevents their close events from changing host
 * connection state.
 */
export interface RunStatusSocketAttachment {
  kind: "run-status";
  runId: string;
  userId: string;
  hostId: string;
  sessionId: string;
  expiresAt: number;
}

export class HostRuntimeBase extends DurableObject<Cloudflare.Env> {
  protected readonly runProjectionQueues = new Map<string, Promise<void>>();
  protected knownHostId: string | null | undefined;

  constructor(
    ctx: DurableObjectState,
    override readonly env: Cloudflare.Env,
  ) {
    super(ctx, env);
    // Browsers keep their run status socket alive with this ping. Agents only
    // send bridge JSON, so the one auto-response pair a Durable Object holds
    // never answers them.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RUN_STATUS_PING, RUN_STATUS_PONG),
    );
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

  protected persistRunState(
    runId: string,
    deriveNextState: (current: RunStateDocument) => RunStateDocument,
    options?: Parameters<typeof persistRunState>[3],
  ): Promise<RunProjectionOutcome> {
    return persistRunState(this.env.DB, runId, deriveNextState, options);
  }

  protected async scheduleNextAlarm(hostId: string): Promise<void> {
    await this.armNextAlarm(await this.computeNextAlarm(hostId));
  }

  protected async scheduleAlarmNoLaterThan(timestamp: number): Promise<void> {
    await this.armNextAlarm(timestamp);
  }

  protected async scheduleSocketExpiry(): Promise<void> {
    await this.armNextAlarm();
  }

  protected async runtimeAlarmIsDue(): Promise<boolean> {
    const deadline = await this.ctx.storage.get<number | null>(RUNTIME_ALARM_KEY);
    // An alarm created before separate socket deadlines existed is runtime work.
    return deadline === undefined || (deadline !== null && deadline <= Date.now());
  }

  private async armNextAlarm(runtimeDeadline?: number | null): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const currentAlarm = await storage.getAlarm();
      const stored = await storage.get<number | null>(RUNTIME_ALARM_KEY);
      let runtime = stored === undefined ? currentAlarm : stored;
      if (runtimeDeadline !== undefined) {
        // A stored deadline counts while it lies ahead, or while its alarm
        // is still set: one armed for "now" has not run yet, and a later
        // "no later than" must not push it back. Inside a running alarm no
        // alarm is set, so a deadline that has been served is replaced.
        const pending = runtime !== null && (runtime > Date.now() || currentAlarm !== null);
        runtime = pending
          ? Math.min(runtime as number, runtimeDeadline ?? Infinity)
          : runtimeDeadline;
      }
      if (stored !== runtime) await storage.put(RUNTIME_ALARM_KEY, runtime);
      // Read attachments after all awaits: concurrent accepts must not lose
      // their earlier deadline to a slower maintenance calculation.
      const next = Math.min(runtime ?? Infinity, this.nextSocketExpiry());
      if (next === Infinity) await storage.deleteAlarm();
      else if (next !== currentAlarm) await storage.setAlarm(next);
    });
  }

  private socketExpiry(socket: WebSocket): number {
    const status = this.readRunStatusSocketAttachment(socket);
    if (status) return status.expiresAt;
    const agent = this.readSocketAttachment(socket);
    if (!agent) return 0;
    return agent.helloReceived ? Infinity : agent.connectedAt + HOST_HELLO_TIMEOUT_MS;
  }

  private nextSocketExpiry(): number {
    let next = Infinity;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        next = Math.min(next, this.socketExpiry(socket));
      }
    }
    return next;
  }

  protected closeExpiredSockets(): void {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN || this.socketExpiry(socket) > now) continue;
      try {
        socket.close(1008, "socket admission expired");
      } catch {
        // One disconnected socket must not stop cleanup of the others.
      }
    }
  }

  protected async computeNextAlarm(hostId: string): Promise<number | null> {
    const now = Date.now();
    const activeSocket = await this.findActiveSocket(hostId);
    const desiredState = await loadStoredHostDesiredState(
      drizzle(this.env.DB),
      hostId,
      now,
    );
    const lag = await this.loadDesiredVersionLag(hostId, now, desiredState);
    const undeliveredDesired = activeSocket
      ? activeSocket.attachment.lastDesiredVersionSent !== desiredState.version
      : false;
    const nextLeaseExpiry = (desiredState.vms as Array<{ desired_phase: string; lease_expires_at_unix_ms: number }>)
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
    if (
      !activeSocket &&
      !undeliveredDesired &&
      typeof nextLeaseExpiry !== "number" &&
      typeof nextRuntimeLeaseExpiry !== "number" &&
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
    if (lag.lagging && activeSocket) {
      // The re-push waits for the threshold after the last dispatch, so aim one
      // tick past it. A fallback alarm armed from a reading taken before that
      // dispatch fires just short of it, and timing from that alarm's own clock
      // would leave the re-push a whole threshold late. Once that time passed
      // without a re-push, keep the threshold cadence rather than spin.
      const repushAt =
        (activeSocket.attachment.lastDesiredDispatchAtMs ?? now) +
        DESIRED_VERSION_LAG_REPUSH_AFTER_MS +
        1;
      candidates.push(
        repushAt > now ? repushAt : now + DESIRED_VERSION_LAG_REPUSH_AFTER_MS,
      );
    }
    return Math.min(...candidates);
  }

  protected async handleSocketClosed(ws: WebSocket): Promise<void> {
    const attachment = this.readSocketAttachment(ws);
    if (!attachment?.sessionId) {
      return;
    }
    const now = Date.now();
    // A close can only release its own session. Never revive an older socket
    // or overwrite a replacement hello that committed while D1 was in flight.
    const updated = await drizzle(this.env.DB).update(agentHosts).set({
      activeSessionId: null, connected: false, disconnectedAt: now, updatedAt: now,
    }).where(and(
      eq(agentHosts.id, attachment.hostId),
      eq(agentHosts.activeSessionId, attachment.sessionId),
      eq(agentHosts.credentialGeneration, attachment.credentialGeneration),
    )).returning({ id: agentHosts.id });
    try {
      if (attachment.scope !== "platform") await revokeStargateHostRelay({ hostId: attachment.hostId, sessionId: attachment.sessionId,
        credentialGeneration: attachment.credentialGeneration });
    } finally {
      if (updated.length) await this.scheduleNextAlarm(attachment.hostId);
    }
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
        if (attachment.sessionId && attachment.scope !== "platform") await revokeStargateHostRelay({ hostId,
          sessionId: attachment.sessionId, credentialGeneration: attachment.credentialGeneration });
      } catch (error) {
        console.warn(JSON.stringify({ event: "relay_session_revoke_failed", hostId }));
      } finally {
        try { socket.close(1012, "replaced by newer session"); } catch { /* Already closed. */ }
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

  protected readSocketAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      const parsed = ws.deserializeAttachment() as SocketAttachment | null;
      // An attachment without a known scope cannot be checked against its
      // host. Treat it as missing so the socket closes and reconnects.
      if (
        !parsed ||
        parsed.kind !== "agent" ||
        !Number.isSafeInteger(parsed.credentialGeneration) ||
        parsed.credentialGeneration < 1 ||
        typeof parsed.hostId !== "string" ||
        (parsed.scope !== "personal" && parsed.scope !== "platform" && parsed.scope !== "organization")
      ) {
        return null;
      }
      return {
        kind: "agent",
        hostId: parsed.hostId,
        credentialGeneration: parsed.credentialGeneration,
        organizationId: typeof parsed.organizationId === "string" ? parsed.organizationId : null,
        scope: parsed.scope,
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
        bridgeProtocol: parsed.bridgeProtocol === "v9" ? "v9" : null,
        guestContract: typeof parsed.guestContract === "number" && Number.isSafeInteger(parsed.guestContract) ? parsed.guestContract : null,
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

  protected readRunStatusSocketAttachment(
    ws: WebSocket,
  ): RunStatusSocketAttachment | null {
    try {
      const parsed = ws.deserializeAttachment() as
        | RunStatusSocketAttachment
        | null;
      if (!parsed || parsed.kind !== "run-status") return null;

      const runId = requiredAttachmentId(parsed.runId);
      const userId = requiredAttachmentId(parsed.userId);
      const hostId = requiredAttachmentId(parsed.hostId);
      const sessionId = requiredAttachmentId(parsed.sessionId);
      if (!runId || !userId || !hostId || !sessionId) {
        return null;
      }

      return {
        kind: "run-status",
        runId,
        userId,
        hostId,
        sessionId,
        // Pre-upgrade subscriptions have no bounded lifetime. Close them on
        // the next event instead of assigning them a new lifetime on wake.
        expiresAt: requiredAttachmentTimestamp(parsed.expiresAt) ?? 0,
      };
    } catch {
      return null;
    }
  }

  protected async loadDesiredVersionLag(
    hostId: string,
    nowUnixMs: number,
    desiredState?: HostDesiredStateV3,
  ): Promise<{
    lagging: boolean;
    desiredVersion: number;
    appliedVersion: number | null;
  }> {
    const db = drizzle(this.env.DB);
    const desired =
      desiredState ??
      (await loadStoredHostDesiredState(db, hostId, nowUnixMs));
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

  protected loadRun(runId: string): Promise<RunProjectionRow | null> {
    return loadRunProjection(this.env.DB, runId);
  }

  protected async listOpenRunsForHost(hostId: string): Promise<
    Array<{
      runId: string;
      userId: string;
      executionId: string;
      executionGeneration: number;
      state: RunStateDocument;
      deleteRequestedAt: number | null;
    }>
  > {
    const db = drizzle(this.env.DB);
    const rows = await db
      .select({
        runId: scenarioRuns.runId,
        userId: scenarioRuns.userId,
        executionId: runtimeExecutions.id,
        executionGeneration: runtimeExecutions.generation,
        stateJson: scenarioRuns.stateJson,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      })
      .from(scenarioRuns)
      .innerJoin(runtimeExecutions, eq(runtimeExecutions.id, scenarioRuns.runtimeExecutionId))
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
      executionId: row.executionId,
      executionGeneration: row.executionGeneration,
      state: parseRunState(row.stateJson),
      deleteRequestedAt: row.deleteRequestedAt,
    }));
  }
}

function requiredAttachmentId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
    ? value
    : null;
}

function requiredAttachmentTimestamp(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}




function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}
