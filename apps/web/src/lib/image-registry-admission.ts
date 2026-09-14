import type {
  ImageRegistryEnforcementMode,
  ImageRegistryGateState,
  ImageRegistryGcRunState,
  ImageRegistryOperationKind,
  ImageRegistrySessionOwnerKind,
  ImageRegistrySessionState,
  ImageRegistryWriterOutcome,
} from "@/db/schema";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  hasRegistryPublishToken,
  jsonResponse,
} from "@/control-plane/image-registry/shared";

/**
 * Registry admission serialises the shared writers of the image registry
 * (uploads, publishes, catalog pointer mutations) against the one exclusive
 * collector sweep. The rules live in D1, not in a client:
 *
 * - a sweep cannot start while an upload session or writer lease is unresolved;
 * - a writer cannot enter while a sweep holds the gate, and the gate epoch moves
 *   on every sweep, so an already-paused request is rejected instead of
 *   continuing;
 * - an interrupted write stays unresolved and blocks the sweep until an operator
 *   reaps it; there is no timeout that silently takes it over.
 *
 * The session owner always comes from the verified credential. No request body
 * can name an owner.
 */

export const REGISTRY_SESSION_HEADER = "x-intar-registry-session";
export const REGISTRY_ADMISSION_PROTOCOL_VERSION = 1;
export const REGISTRY_ADMISSION_KEY = "image_registry_admission";
export const REGISTRY_SESSION_LEASE_MS = 10 * 60 * 1000;
export const REGISTRY_OPERATION_LEASE_MS = 5 * 60 * 1000;
export const REGISTRY_SWEEP_LEASE_MS = 5 * 60 * 1000;
export const REGISTRY_HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const REGISTRY_REAP_GRACE_MS = 60 * 60 * 1000;
export const REGISTRY_REAP_BATCH_SIZE = 500;
/** How long a closed session row stays for idempotent retries and diagnosis. */
export const REGISTRY_CLOSED_SESSION_RETAIN_MS = 6 * 60 * 60 * 1000;

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The D1-only surface. The collector runs in a child Worker that shares the
 * database but not this module graph, so every sweep helper keeps the smallest
 * possible environment contract and is reusable behind a private RPC.
 */
export interface RegistryAdmissionEnv {
  DB: D1Database;
}

export interface RegistryAdmissionOwner {
  kind: ImageRegistrySessionOwnerKind;
  id: string;
}

export type RegistryAuthResult =
  | { ok: true; owner: RegistryAdmissionOwner }
  | { ok: false; response: Response };

export interface RegistryAdmissionCounts {
  openSessions: number;
  staleOpenSessions: number;
  pendingWriters: number;
  stalePendingWriters: number;
  unknownWriters: number;
}

export interface RegistryAdmissionState {
  protocolVersion: number;
  enforcement: ImageRegistryEnforcementMode;
  epoch: number;
  state: ImageRegistryGateState;
  paused: boolean;
  pauseReason: string | null;
  sweep: {
    active: boolean;
    stalled: boolean;
    token: string | null;
    owner: string | null;
    startedAtMs: number | null;
    heartbeatAtMs: number | null;
    expiresAtMs: number | null;
  };
  counts: RegistryAdmissionCounts;
}

export interface RegistryOperationLease {
  operationId: string;
  sessionId: string | null;
  epoch: number;
  complete(outcome: "ok" | "error" | "unknown"): Promise<void>;
}

export interface RegistrySweepLease {
  sweepToken: string;
  epoch: number;
  startedAtMs: number;
  expiresAtMs: number;
  heartbeatIntervalMs: number;
  deleteAllowed: boolean;
  blockedReason: string | null;
}

const registryAuthByRequest = new WeakMap<Request, Promise<RegistryAuthResult>>();

/**
 * Verifies the registry credential once per request and remembers it, so the
 * router wrapper and the handler do not verify twice.
 */
export function readRegistryAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<RegistryAuthResult> {
  const cached = registryAuthByRequest.get(request);
  if (cached) return cached;
  const pending = verifyRegistryAuth(request, env);
  registryAuthByRequest.set(request, pending);
  return pending;
}

async function verifyRegistryAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<RegistryAuthResult> {
  if (await hasRegistryPublishToken(request, env)) {
    return { ok: true, owner: { kind: "publish_token", id: "publish-token" } };
  }
  const verified = await requireVerifiedAgentRequest(request, env);
  if (verified.ok) {
    if (verified.agent.role === "builder") {
      return { ok: true, owner: { kind: "builder", id: verified.agent.hostId } };
    }
    return {
      ok: false,
      response: jsonResponse({ error: "builder role required" }, 403),
    };
  }
  return { ok: false, response: jsonResponse({ error: "unauthorized" }, 401) };
}

export async function requireRegistryAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<RegistryAuthResult> {
  return readRegistryAuth(request, env);
}

export function readRegistrySessionId(request: Request): string | null {
  return request.headers.get(REGISTRY_SESSION_HEADER)?.trim() || null;
}

export async function readRegistryAdmissionState(
  env: RegistryAdmissionEnv,
): Promise<RegistryAdmissionState> {
  const now = Date.now();
  const [gate, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT protocol_version, enforcement, epoch, state, sweep_token, sweep_owner,
              sweep_started_at, sweep_heartbeat_at, sweep_expires_at,
              paused_at, pause_reason
         FROM image_registry_admission
        WHERE key = ?1`,
    )
      .bind(REGISTRY_ADMISSION_KEY)
      .first<{
        protocol_version: number;
        enforcement: ImageRegistryEnforcementMode;
        epoch: number;
        state: ImageRegistryGateState;
        sweep_token: string | null;
        sweep_owner: string | null;
        sweep_started_at: number | null;
        sweep_heartbeat_at: number | null;
        sweep_expires_at: number | null;
        paused_at: number | null;
        pause_reason: string | null;
      }>(),
    readRegistryAdmissionCounts(env, now),
  ]);

  const expiresAtMs = gate?.sweep_expires_at ?? null;
  const sweepActive = gate?.state === "sweeping" && gate.sweep_token !== null;
  return {
    protocolVersion: gate?.protocol_version ?? REGISTRY_ADMISSION_PROTOCOL_VERSION,
    enforcement: gate?.enforcement ?? "report_only",
    epoch: gate?.epoch ?? 0,
    state: gate?.state ?? "open",
    paused: gate?.paused_at != null,
    pauseReason: gate?.pause_reason ?? null,
    sweep: {
      // A sweep stays active after its heartbeat expires. An expired lease is
      // diagnosis, not release authority: no one can prove the old delete loop
      // stopped. Only an operator resolves a stalled sweep.
      active: sweepActive,
      stalled: sweepActive && expiresAtMs !== null && expiresAtMs <= now,
      token: gate?.sweep_token ?? null,
      owner: gate?.sweep_owner ?? null,
      startedAtMs: gate?.sweep_started_at ?? null,
      heartbeatAtMs: gate?.sweep_heartbeat_at ?? null,
      expiresAtMs,
    },
    counts,
  };
}

async function readRegistryAdmissionCounts(
  env: RegistryAdmissionEnv,
  now: number,
): Promise<RegistryAdmissionCounts> {
  const row = await env.DB.prepare(
    // A writer row is a hold while it is unresolved (the process never
    // reported) or while it ended inconclusively (outcome 'unknown'). Settled
    // rows are deleted on release, so they are not counted and cannot grow.
    `SELECT
       (SELECT COUNT(*) FROM image_registry_upload_sessions WHERE state = 'open') AS open_sessions,
       (SELECT COUNT(*) FROM image_registry_upload_sessions WHERE state = 'open' AND expires_at <= ?1) AS stale_open_sessions,
       (SELECT COUNT(*) FROM image_registry_operation_writers
         WHERE released_at IS NULL OR outcome = 'unknown') AS pending_writers,
       (SELECT COUNT(*) FROM image_registry_operation_writers
         WHERE (released_at IS NULL OR outcome = 'unknown')
           AND expires_at <= ?1) AS stale_pending_writers,
       (SELECT COUNT(*) FROM image_registry_operation_writers
         WHERE released_at IS NOT NULL AND outcome = 'unknown') AS unknown_writers`,
  )
    .bind(now)
    .first<{
      open_sessions: number;
      stale_open_sessions: number;
      pending_writers: number;
      stale_pending_writers: number;
      unknown_writers: number;
    }>();
  return {
    openSessions: row?.open_sessions ?? 0,
    staleOpenSessions: row?.stale_open_sessions ?? 0,
    pendingWriters: row?.pending_writers ?? 0,
    stalePendingWriters: row?.stale_pending_writers ?? 0,
    unknownWriters: row?.unknown_writers ?? 0,
  };
}

export function registryAdmissionBlockedReason(
  counts: RegistryAdmissionCounts,
): string | null {
  if (counts.openSessions > 0) return "registry_upload_session_open";
  if (counts.pendingWriters > 0) return "registry_write_unresolved";
  return null;
}

/**
 * Only the object-creating upload path opens an upload session. Operator
 * operations (catalog pointers, guest-tools convergence) are single short
 * commits: forcing an operator workflow to open an upload session would make
 * the collector unreachable and adds no protection.
 */
export function operationNeedsSession(
  operation: ImageRegistryOperationKind,
): boolean {
  return (
    operation !== "pointer_mutation" && operation !== "guest_tools"
  );
}

/**
 * Registers one shared writer for the request that is about to run. The insert
 * is guarded by the gate and by the caller's own session in the same D1 batch,
 * so a sweep that started in between rejects the writer instead of racing it.
 */
export async function admitRegistryOperation(
  request: Request,
  env: Cloudflare.Env,
  input: {
    operation: ImageRegistryOperationKind;
    requireSession?: boolean;
  },
): Promise<{ ok: true; lease: RegistryOperationLease } | { ok: false; response: Response }> {
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return { ok: false, response: auth.response };

  const state = await readRegistryAdmissionState(env);
  const sessionId = readRegistrySessionId(request);
  if (sessionId && !SESSION_ID_RE.test(sessionId)) {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid registry session id" }, 400),
    };
  }
  const requireSession =
    input.requireSession ??
    (state.enforcement === "enforce" && operationNeedsSession(input.operation));
  if (!sessionId && requireSession) {
    return { ok: false, response: registrySessionRequiredResponse() };
  }

  const now = Date.now();
  const operationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    ensureRegistryAdmissionRow(env, now),
  ];
  if (sessionId) {
    statements.push(
      touchRegistryUploadSession(env, {
        sessionId,
        owner: auth.owner,
        now,
      }),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO image_registry_operation_writers
         (id, session_id, owner_kind, owner_id, operation, epoch, outcome,
          created_at, heartbeat_at, expires_at, released_at)
       SELECT ?1, ?2, ?3, ?4, ?5, gate.epoch, 'pending', ?6, ?6, ?7, NULL
         FROM image_registry_admission gate
        WHERE gate.key = ?8
          AND gate.state = 'open'
          AND gate.paused_at IS NULL
          AND (gate.sweep_expires_at IS NULL OR gate.sweep_expires_at <= ?6)
          AND (?2 IS NULL OR EXISTS (
                SELECT 1 FROM image_registry_upload_sessions session
                 WHERE session.id = ?2
                   AND session.owner_kind = ?3
                   AND session.owner_id = ?4
                   AND session.state = 'open'
                   AND session.expires_at > ?6))
       RETURNING id, epoch`,
    ).bind(
      operationId,
      sessionId,
      auth.owner.kind,
      auth.owner.id,
      input.operation,
      now,
      now + REGISTRY_OPERATION_LEASE_MS,
      REGISTRY_ADMISSION_KEY,
    ),
  );

  const results = await env.DB.batch(statements);
  const writer = firstRow(results.at(-1));
  if (!writer) {
    return {
      ok: false,
      response: await registryAdmissionRejection(env, sessionId, auth.owner),
    };
  }

  return {
    ok: true,
    lease: {
      operationId,
      sessionId,
      epoch: numberFrom(writer.epoch),
      complete: (outcome) =>
        releaseRegistryOperation(env, {
          operationId,
          outcome,
        }),
    },
  };
}

/**
 * The owner of a writer row that the parent Worker opens on its own behalf. It
 * holds no registry credential and no upload session, so the identity must come
 * from server code that already authenticated the caller. A request body or a
 * request header must never decide it.
 */
export interface RegistryInternalWriterOwner {
  kind: "system";
  id: string;
}

/**
 * How long an internal writer claims to live. It only has to outlive one D1
 * commit, and a request that dies before its release leaves a hold that blocks
 * every destructive sweep until an operator reap, so the lease stays short.
 */
export const REGISTRY_INTERNAL_WRITER_LEASE_MS = 2 * 60 * 1000;

export type RegistryInternalWriterRefusal =
  | "registry_paused"
  | "registry_sweep_active"
  | "registry_sweep_stalled"
  | "registry_gate_closed";

export type RegistryInternalWriterAdmission =
  | { ok: true; lease: RegistryOperationLease }
  | { ok: false; reason: RegistryInternalWriterRefusal };

/**
 * Opens one shared writer for a short internal window, such as a learner run
 * start that reads a scenario image reference and then commits the run that
 * points at it. The insert carries the same gate guard as the routing
 * admission, so a sweep that already holds the gate refuses the window instead
 * of racing it, and the collector refuses to acquire while the window is open.
 */
export async function admitInternalRegistryOperation(
  env: RegistryAdmissionEnv,
  input: {
    operation: ImageRegistryOperationKind;
    owner: RegistryInternalWriterOwner;
  },
): Promise<RegistryInternalWriterAdmission> {
  const now = Date.now();
  const operationId = crypto.randomUUID();
  const results = await env.DB.batch([
    ensureRegistryAdmissionRow(env, now),
    env.DB.prepare(
      `INSERT INTO image_registry_operation_writers
         (id, session_id, owner_kind, owner_id, operation, epoch, outcome,
          created_at, heartbeat_at, expires_at, released_at)
       SELECT ?1, NULL, ?2, ?3, ?4, gate.epoch, 'pending', ?5, ?5, ?6, NULL
         FROM image_registry_admission gate
        WHERE gate.key = ?7
          AND gate.state = 'open'
          AND gate.paused_at IS NULL
          AND (gate.sweep_expires_at IS NULL OR gate.sweep_expires_at <= ?5)
       RETURNING id, epoch`,
    ).bind(
      operationId,
      input.owner.kind,
      input.owner.id,
      input.operation,
      now,
      now + REGISTRY_INTERNAL_WRITER_LEASE_MS,
      REGISTRY_ADMISSION_KEY,
    ),
  ]);
  const writer = firstRow(results.at(-1));
  if (!writer) {
    return { ok: false, reason: await readInternalWriterRefusal(env) };
  }
  return {
    ok: true,
    lease: {
      operationId,
      sessionId: null,
      epoch: numberFrom(writer.epoch),
      complete: (outcome) =>
        releaseRegistryOperation(env, {
          operationId,
          outcome,
        }),
    },
  };
}

/** Names why the gate refused an internal writer, from a fresh read. */
async function readInternalWriterRefusal(
  env: RegistryAdmissionEnv,
): Promise<RegistryInternalWriterRefusal> {
  const state = await readRegistryAdmissionState(env);
  if (state.paused) return "registry_paused";
  if (state.sweep.active) {
    return state.sweep.stalled
      ? "registry_sweep_stalled"
      : "registry_sweep_active";
  }
  return "registry_gate_closed";
}

/**
 * Writer guard for a handler that writes in stages, such as a publish that
 * stores images, commits catalog pointers, and then asks the collector to
 * sweep. The guard holds the lease across the writes and settles it before the
 * long collector request, so the two can never overlap.
 *
 * `release` is idempotent. `finish` is the safety net for a path that never
 * reached an explicit release: it records a hold when a write may already have
 * landed, and a settled end when the request was rejected before any write.
 */
export interface RegistryWriterGuard {
  /** Records that the first write may now have started. */
  markWriteStarted(): void;
  /** Settles the guard. Later calls do nothing. */
  release(outcome: "ok" | "error" | "unknown"): Promise<void>;
  /** Settles the guard for a path that did not release it explicitly. */
  finish(): Promise<void>;
}

export function createRegistryWriterGuard(
  lease: RegistryOperationLease,
): RegistryWriterGuard {
  let writeStarted = false;
  let released = false;
  const release = async (
    outcome: "ok" | "error" | "unknown",
  ): Promise<void> => {
    if (released) return;
    released = true;
    writeStarted = true;
    await lease.complete(outcome);
  };
  return {
    markWriteStarted(): void {
      writeStarted = true;
    },
    release,
    async finish(): Promise<void> {
      if (released) return;
      // A request that was rejected before its first write is settled: nothing
      // was stored, so no sweep needs protection from it. A request that threw
      // after a write began is a hold, because part of it may have committed.
      await release(writeStarted ? "unknown" : "error");
    },
  };
}

async function releaseRegistryOperation(
  env: RegistryAdmissionEnv,
  input: { operationId: string; outcome: ImageRegistryWriterOutcome },
): Promise<void> {
  const now = Date.now();
  try {
    if (input.outcome === "unknown") {
      // An inconclusive end is a hold: the write may have landed partially, so
      // the row stays and blocks destruction until an operator resolves it.
      await env.DB.prepare(
        `UPDATE image_registry_operation_writers
            SET outcome = 'unknown', released_at = ?1, heartbeat_at = ?1
          WHERE id = ?2 AND released_at IS NULL`,
      )
        .bind(now, input.operationId)
        .run();
      return;
    }
    // A settled operation is deleted, not archived: the row exists only while
    // the write it guards can still be in flight. Keeping every settled row
    // would trade R2 growth for unbounded D1 growth on the chunk-upload path.
    await env.DB.prepare(
      "DELETE FROM image_registry_operation_writers WHERE id = ?1",
    )
      .bind(input.operationId)
      .run();
  } catch {
    // A release that cannot be written leaves the row unresolved, which blocks
    // the destructive sweep until an operator reaps it. Losing the release must
    // not turn a successful upload into a failed response.
  }
}

function ensureRegistryAdmissionRow(
  env: RegistryAdmissionEnv,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO image_registry_admission
       (key, protocol_version, enforcement, epoch, state, updated_at)
     VALUES (?1, ?2, 'report_only', 0, 'open', ?3)`,
  ).bind(REGISTRY_ADMISSION_KEY, REGISTRY_ADMISSION_PROTOCOL_VERSION, now);
}

function touchRegistryUploadSession(
  env: RegistryAdmissionEnv,
  input: { sessionId: string; owner: RegistryAdmissionOwner; now: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE image_registry_upload_sessions
        SET heartbeat_at = ?1, expires_at = ?2
      WHERE id = ?3
        AND owner_kind = ?4
        AND owner_id = ?5
        AND state = 'open'
        AND expires_at > ?1
      RETURNING id`,
  ).bind(
    input.now,
    input.now + REGISTRY_SESSION_LEASE_MS,
    input.sessionId,
    input.owner.kind,
    input.owner.id,
  );
}

export function registrySessionRequiredResponse(): Response {
  return jsonResponse(
    {
      error: "registry upload session is required",
      code: "registry_session_required",
      session_header: REGISTRY_SESSION_HEADER,
    },
    400,
  );
}

async function registryAdmissionRejection(
  env: RegistryAdmissionEnv,
  sessionId: string | null,
  owner: RegistryAdmissionOwner,
): Promise<Response> {
  const state = await readRegistryAdmissionState(env);
  if (state.paused) {
    return jsonResponse(
      {
        error: "image registry operations are paused",
        code: "registry_paused",
        reason: state.pauseReason,
      },
      409,
    );
  }
  if (state.sweep.active) {
    return jsonResponse(
      {
        error: "registry sweep is in progress",
        code: "registry_sweep_in_progress",
        sweep_owner: state.sweep.owner,
        expires_at_unix_ms: state.sweep.expiresAtMs,
        stalled: state.sweep.stalled,
      },
      409,
    );
  }
  if (sessionId) {
    const failure = await describeRegistrySessionFailure(env, sessionId, owner);
    if (failure) return failure;
  }
  return jsonResponse(
    { error: "registry admission denied", code: "registry_admission_denied" },
    409,
  );
}

export async function describeRegistrySessionFailure(
  env: RegistryAdmissionEnv,
  sessionId: string,
  owner?: RegistryAdmissionOwner,
): Promise<Response | null> {
  const session = await env.DB.prepare(
    `SELECT id, owner_kind, owner_id, state, expires_at
       FROM image_registry_upload_sessions WHERE id = ?1`,
  )
    .bind(sessionId)
    .first<{
      id: string;
      owner_kind: ImageRegistrySessionOwnerKind;
      owner_id: string;
      state: ImageRegistrySessionState;
      expires_at: number;
    }>();
  if (!session) {
    return jsonResponse(
      { error: "unknown registry upload session", code: "registry_session_unknown" },
      404,
    );
  }
  // A header value is not a session. The session must belong to the credential
  // that sends it, otherwise one uploader could borrow another's protection.
  if (
    owner &&
    (session.owner_kind !== owner.kind || session.owner_id !== owner.id)
  ) {
    return jsonResponse(
      {
        error: "registry upload session belongs to another owner",
        code: "registry_session_owner_mismatch",
      },
      403,
    );
  }
  if (session.state !== "open") {
    return jsonResponse(
      {
        error: "registry upload session is closed",
        code: "registry_session_closed",
        state: session.state,
      },
      409,
    );
  }
  return jsonResponse(
    {
      error: "registry upload session lease expired",
      code: "registry_session_superseded",
    },
    409,
  );
}

export async function createRegistryUploadSession(
  env: RegistryAdmissionEnv,
  input: { owner: RegistryAdmissionOwner; intent?: string | null; sessionId?: string },
): Promise<{ ok: true; sessionId: string; expiresAtMs: number; epoch: number } | { ok: false; response: Response }> {
  const now = Date.now();
  const sessionId = input.sessionId ?? crypto.randomUUID();
  const expiresAtMs = now + REGISTRY_SESSION_LEASE_MS;
  const results = await env.DB.batch([
    ensureRegistryAdmissionRow(env, now),
    env.DB.prepare(
      `INSERT INTO image_registry_upload_sessions
         (id, owner_kind, owner_id, intent, epoch, state, created_at,
          heartbeat_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, gate.epoch, 'open', ?5, ?5, ?6
         FROM image_registry_admission gate
        WHERE gate.key = ?7
          AND gate.state = 'open'
          AND (gate.sweep_expires_at IS NULL OR gate.sweep_expires_at <= ?5)
       RETURNING id, epoch, expires_at`,
    ).bind(
      sessionId,
      input.owner.kind,
      input.owner.id,
      input.intent?.trim() || null,
      now,
      expiresAtMs,
      REGISTRY_ADMISSION_KEY,
    ),
  ]);
  const created = firstRow(results.at(-1));
  if (!created) {
    const state = await readRegistryAdmissionState(env);
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "registry sweep is in progress",
          code: "registry_sweep_in_progress",
          sweep_owner: state.sweep.owner,
          expires_at_unix_ms: state.sweep.expiresAtMs,
        },
        409,
      ),
    };
  }
  return {
    ok: true,
    sessionId,
    expiresAtMs: numberFrom(created.expires_at) || expiresAtMs,
    epoch: numberFrom(created.epoch),
  };
}

export async function heartbeatRegistryUploadSession(
  env: RegistryAdmissionEnv,
  input: { owner: RegistryAdmissionOwner; sessionId: string },
): Promise<
  | { ok: true; expiresAtMs: number; epoch: number }
  | { ok: false; response: Response }
> {
  const now = Date.now();
  const results = await env.DB.batch([
    touchRegistryUploadSession(env, {
      sessionId: input.sessionId,
      owner: input.owner,
      now,
    }),
  ]);
  const touched = firstRow(results[0]);
  if (touched) {
    const state = await readRegistryAdmissionState(env);
    if (state.sweep.active) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: "registry sweep is in progress",
            code: "registry_sweep_in_progress",
            sweep_owner: state.sweep.owner,
            expires_at_unix_ms: state.sweep.expiresAtMs,
          },
          409,
        ),
      };
    }
    return {
      ok: true,
      expiresAtMs: now + REGISTRY_SESSION_LEASE_MS,
      epoch: numberFrom(touched.epoch),
    };
  }

  const session = await env.DB.prepare(
    `SELECT owner_kind, owner_id, state, expires_at
       FROM image_registry_upload_sessions WHERE id = ?1`,
  )
    .bind(input.sessionId)
    .first<{
      owner_kind: ImageRegistrySessionOwnerKind;
      owner_id: string;
      state: ImageRegistrySessionState;
      expires_at: number;
    }>();
  if (!session) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "unknown registry upload session", code: "registry_session_unknown" },
        404,
      ),
    };
  }
  if (
    session.owner_kind !== input.owner.kind ||
    session.owner_id !== input.owner.id
  ) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "registry upload session belongs to another owner",
          code: "registry_session_owner_mismatch",
        },
        403,
      ),
    };
  }
  if (session.state !== "open") {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "registry upload session is closed",
          code: "registry_session_closed",
          state: session.state,
        },
        409,
      ),
    };
  }
  return {
    ok: false,
    response: jsonResponse(
      {
        error: "registry upload session lease expired",
        code: "registry_session_superseded",
      },
      409,
    ),
  };
}

/**
 * Closes a session and resolves its unresolved writers. A completed session
 * means every write it started is accounted for; an abandoned session means the
 * uploader will not publish, so its partial objects are sweepable.
 */
export async function completeRegistryUploadSession(
  env: RegistryAdmissionEnv,
  input: {
    owner: RegistryAdmissionOwner;
    sessionId: string;
    outcome: "published" | "abandoned";
  },
): Promise<
  | { ok: true; state: ImageRegistrySessionState; releasedWriters: number }
  | { ok: false; response: Response }
> {
  const now = Date.now();
  const sessionState: ImageRegistrySessionState =
    input.outcome === "published" ? "completed" : "abandoned";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE image_registry_upload_sessions
          SET state = ?1, closed_at = ?2, close_reason = ?3
        WHERE id = ?4
          AND owner_kind = ?5
          AND owner_id = ?6
          AND state = 'open'
        RETURNING id`,
    ).bind(
      sessionState,
      now,
      input.outcome,
      input.sessionId,
      input.owner.kind,
      input.owner.id,
    ),
    env.DB.prepare(
      // A closed session settles the rows it owns: published means the upload
      // completed, abandoned means the uploader will not publish. Rows that were
      // never reported, or that ended inconclusively, stay as holds and still
      // block destruction. This removes leftovers only, because a settled
      // operation deletes its own row.
      `DELETE FROM image_registry_operation_writers
        WHERE session_id = ?1
          AND released_at IS NOT NULL
          AND outcome <> 'unknown'
          AND EXISTS (
                SELECT 1 FROM image_registry_upload_sessions session
                 WHERE session.id = ?1
                   AND session.state IN ('completed', 'abandoned', 'reaped'))
        RETURNING id`,
    ).bind(input.sessionId),
  ]);

  const closed = firstRow(results[0]);
  const releasedWriters = rowCount(results[1]);
  // Closing is the once-per-upload point where the bounded history is trimmed,
  // so the admission tables stay small without a scheduled job.
  if (closed) await compactRegistryAdmissionHistory(env);
  const session = await env.DB.prepare(
    `SELECT owner_kind, owner_id, state FROM image_registry_upload_sessions WHERE id = ?1`,
  )
    .bind(input.sessionId)
    .first<{
      owner_kind: ImageRegistrySessionOwnerKind;
      owner_id: string;
      state: ImageRegistrySessionState;
    }>();
  if (!session) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "unknown registry upload session", code: "registry_session_unknown" },
        404,
      ),
    };
  }
  if (
    session.owner_kind !== input.owner.kind ||
    session.owner_id !== input.owner.id
  ) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "registry upload session belongs to another owner",
          code: "registry_session_owner_mismatch",
        },
        403,
      ),
    };
  }
  return {
    ok: true,
    state: closed ? sessionState : session.state,
    releasedWriters,
  };
}

/**
 * Deliberate operator takeover of stale rows. Nothing in the request path can
 * replace this: an interrupted write blocks the sweep until an operator decides.
 */
export async function reapRegistryAdmission(
  env: RegistryAdmissionEnv,
  input: { graceMs?: number; limit?: number; resolveStalledSweeps?: boolean } = {},
): Promise<{
  reapedSessions: string[];
  reapedWriters: string[];
  resolvedSweeps: string[];
  /** Closed sessions removed by the bounded history compaction. */
  compactedSessions: number;
}> {
  const now = Date.now();
  const cutoff =
    now - (input.graceMs === undefined ? REGISTRY_REAP_GRACE_MS : input.graceMs);
  const limit = input.limit ?? REGISTRY_REAP_BATCH_SIZE;
  let resolvedSweepIndex: number | null = null;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE image_registry_upload_sessions
          SET state = 'reaped', closed_at = ?1, close_reason = 'operator_reap'
        WHERE id IN (
              SELECT id FROM image_registry_upload_sessions
               WHERE state = 'open' AND expires_at <= ?2
               ORDER BY expires_at
               LIMIT ?3)
        RETURNING id`,
    ).bind(now, cutoff, limit),
    env.DB.prepare(
      // The operator resolves an interrupted write by removing its row. The row
      // is coordination state; the gc run summary is the history that is kept.
      `DELETE FROM image_registry_operation_writers
        WHERE id IN (
              SELECT id FROM image_registry_operation_writers
               WHERE released_at IS NULL AND expires_at <= ?1
               ORDER BY expires_at
               LIMIT ?2)
        RETURNING id`,
    ).bind(cutoff, limit),
    env.DB.prepare(
      // A held row already reported its end; an operator resolves it here.
      `DELETE FROM image_registry_operation_writers
        WHERE id IN (
              SELECT id FROM image_registry_operation_writers
               WHERE released_at IS NOT NULL AND outcome = 'unknown'
               ORDER BY released_at
               LIMIT ?1)
        RETURNING id`,
    ).bind(limit),
  ];
  // Resolving a stalled sweep is the only path that releases the gate without a
  // collector finish. It is an operator decision because an expired heartbeat
  // cannot prove the previous delete loop stopped.
  if (input.resolveStalledSweeps) {
    statements.push(
      env.DB.prepare(
        `UPDATE image_registry_gc_runs
            SET state = 'aborted',
                error = COALESCE(error, 'sweep stalled and was resolved by an operator'),
                finished_at = ?1,
                updated_at = ?1
          WHERE state = 'running'
            AND heartbeat_at <= ?2
          RETURNING id`,
      ).bind(now, cutoff),
    );
    resolvedSweepIndex = statements.length;
    statements.push(
      // This statement keeps the sweep token so the caller can report which
      // sweep was resolved. The token is cleared right after: RETURNING reports
      // post-update values, so clearing it here would report nothing.
      env.DB.prepare(
        `UPDATE image_registry_admission
            SET state = 'open',
                sweep_owner = NULL,
                sweep_started_at = NULL,
                sweep_heartbeat_at = NULL,
                sweep_expires_at = NULL,
                updated_at = ?1
          WHERE key = ?2
            AND state = 'sweeping'
            AND sweep_heartbeat_at IS NOT NULL
            AND sweep_heartbeat_at <= ?3
            AND NOT EXISTS (
                  SELECT 1 FROM image_registry_gc_runs WHERE state = 'running')
          RETURNING sweep_token`,
      ).bind(now, REGISTRY_ADMISSION_KEY, cutoff),
      env.DB.prepare(
        `UPDATE image_registry_admission
            SET sweep_token = NULL, updated_at = ?1
          WHERE key = ?2 AND state = 'open' AND sweep_expires_at IS NULL`,
      ).bind(now, REGISTRY_ADMISSION_KEY),
    );
  }
  const results = await env.DB.batch(statements);
  const compacted = await compactRegistryAdmissionHistory(env);
  return {
    reapedSessions: rowIds(results[0], "id"),
    reapedWriters: [
      ...rowIds(results[1], "id"),
      ...rowIds(results[2], "id"),
    ],
    resolvedSweeps:
      resolvedSweepIndex === null
        ? []
        : rowIds(results[resolvedSweepIndex], "sweep_token"),
    compactedSessions: compacted.removedSessions,
  };
}

export async function setRegistryEnforcement(
  env: RegistryAdmissionEnv,
  mode: ImageRegistryEnforcementMode,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO image_registry_admission
       (key, protocol_version, enforcement, epoch, state, updated_at)
     VALUES (?1, ?2, ?3, 0, 'open', ?4)
     ON CONFLICT(key) DO UPDATE SET
       enforcement = excluded.enforcement,
       updated_at = excluded.updated_at`,
  )
    .bind(REGISTRY_ADMISSION_KEY, REGISTRY_ADMISSION_PROTOCOL_VERSION, mode, now)
    .run();
}

/**
 * Bounded admission history. A settled operation deletes its own row, so the
 * only writer rows left are holds, which stay until an operator resolves them.
 * This removes closed session rows after the retention window, together with any
 * settled writer row they still own, as long as the session holds no unresolved
 * or inconclusive writer row. The gc run summary is not touched.
 */
export async function compactRegistryAdmissionHistory(
  env: RegistryAdmissionEnv,
  input: { retainClosedSessionsMs?: number } = {},
): Promise<{ removedSessions: number; removedWriters: number }> {
  const cutoff =
    Date.now() -
    (input.retainClosedSessionsMs === undefined
      ? REGISTRY_CLOSED_SESSION_RETAIN_MS
      : input.retainClosedSessionsMs);
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM image_registry_operation_writers
        WHERE released_at IS NOT NULL
          AND outcome <> 'unknown'
          AND session_id IN (
                SELECT id FROM image_registry_upload_sessions
                 WHERE state <> 'open'
                   AND closed_at IS NOT NULL
                   AND closed_at <= ?1)
        RETURNING id`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM image_registry_upload_sessions
        WHERE state <> 'open'
          AND closed_at IS NOT NULL
          AND closed_at <= ?1
          AND NOT EXISTS (
                SELECT 1 FROM image_registry_operation_writers writer
                 WHERE writer.session_id = image_registry_upload_sessions.id)
        RETURNING id`,
    ).bind(cutoff),
  ]);
  return {
    removedWriters: rowCount(results[0]),
    removedSessions: rowCount(results[1]),
  };
}

/**
 * Shared pause. Deploys and child Workers read the same D1 row, so a pause set
 * in one isolate holds everywhere: no writer is admitted, the collector may not
 * delete, and a child that is asked to apply must refuse.
 */
export async function setRegistryPause(
  env: RegistryAdmissionEnv,
  input: { paused: boolean; reason?: string | null },
): Promise<{ paused: boolean; reason: string | null }> {
  const now = Date.now();
  if (input.paused) {
    const reason = input.reason?.trim() || "operator_pause";
    await env.DB.prepare(
      `INSERT INTO image_registry_admission
         (key, protocol_version, enforcement, epoch, state, paused_at,
          pause_reason, updated_at)
       VALUES (?1, ?2, 'report_only', 0, 'open', ?3, ?4, ?3)
       ON CONFLICT(key) DO UPDATE SET
         paused_at = excluded.paused_at,
         pause_reason = excluded.pause_reason,
         updated_at = excluded.updated_at`,
    )
      .bind(REGISTRY_ADMISSION_KEY, REGISTRY_ADMISSION_PROTOCOL_VERSION, now, reason)
      .run();
    return { paused: true, reason };
  }
  await env.DB.prepare(
    `UPDATE image_registry_admission
        SET paused_at = NULL, pause_reason = NULL, updated_at = ?1
      WHERE key = ?2`,
  )
    .bind(now, REGISTRY_ADMISSION_KEY)
    .run();
  return { paused: false, reason: null };
}

export interface RegistryIdleState {
  idle: boolean;
  paused: boolean;
  enforcement: ImageRegistryEnforcementMode;
  sweepActive: boolean;
  sweepStalled: boolean;
  openSessions: number;
  pendingWriters: number;
  unresolvedGcRuns: number;
  blockedReason: string | null;
}

/**
 * One D1 read that answers "may a destructive step run right now?". The child
 * Worker and the deploy path must use this instead of a per-isolate flag, so a
 * state change in the parent is visible everywhere at once.
 */
export async function readRegistryIdleState(
  env: RegistryAdmissionEnv,
): Promise<RegistryIdleState> {
  const state = await readRegistryAdmissionState(env);
  const runs = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM image_registry_gc_runs WHERE state = 'running'",
  ).first<{ count: number }>();
  const unresolvedGcRuns = runs?.count ?? 0;
  const blockedReason = state.sweep.active
    ? state.sweep.stalled
      ? "registry_sweep_stalled"
      : "registry_sweep_active"
    : (registryAdmissionBlockedReason(state.counts) ??
      (unresolvedGcRuns > 0 ? "registry_gc_run_unresolved" : null));
  return {
    idle: !state.paused && blockedReason === null,
    paused: state.paused,
    enforcement: state.enforcement,
    sweepActive: state.sweep.active,
    sweepStalled: state.sweep.stalled,
    openSessions: state.counts.openSessions,
    pendingWriters: state.counts.pendingWriters,
    unresolvedGcRuns,
    blockedReason,
  };
}

export type RegistrySweepAcquisition =
  | { ok: true; lease: RegistrySweepLease; counts: RegistryAdmissionCounts }
  | {
      ok: false;
      code: "registry_sweep_active" | "registry_admission_busy";
      counts: RegistryAdmissionCounts;
      state: RegistryAdmissionState;
    };

/**
 * Takes the exclusive sweep. It refuses while any upload session is open, any
 * writer is unresolved, or a previous run is still `running`. A stale row means
 * an interrupted write whose effect is unknown, and an expired sweep lease does
 * not prove the previous delete loop stopped: only an operator reap may resolve
 * either one.
 */
export async function acquireRegistrySweep(
  env: RegistryAdmissionEnv,
  input: { owner: string; leaseMs?: number; sweepToken?: string; runId?: string },
): Promise<RegistrySweepAcquisition> {
  const now = Date.now();
  const sweepToken = input.sweepToken ?? crypto.randomUUID();
  const runId = input.runId ?? crypto.randomUUID();
  const expiresAtMs = now + (input.leaseMs ?? REGISTRY_SWEEP_LEASE_MS);
  const results = await env.DB.batch([
    ensureRegistryAdmissionRow(env, now),
    env.DB.prepare(
      `INSERT INTO image_registry_admission
         (key, protocol_version, enforcement, epoch, state, sweep_token,
          sweep_owner, sweep_started_at, sweep_heartbeat_at, sweep_expires_at,
          updated_at)
       SELECT ?1, ?2, 'report_only', 1, 'sweeping', ?3, ?4, ?5, ?5, ?6, ?5
       WHERE NOT EXISTS (
               SELECT 1 FROM image_registry_operation_writers
                 WHERE released_at IS NULL OR outcome = 'unknown')
          AND NOT EXISTS (
                SELECT 1 FROM image_registry_upload_sessions
                 WHERE state = 'open')
          AND NOT EXISTS (
                SELECT 1 FROM image_registry_gc_runs
                 WHERE state = 'running')
       ON CONFLICT(key) DO UPDATE SET
         state = 'sweeping',
         sweep_token = excluded.sweep_token,
         sweep_owner = excluded.sweep_owner,
         sweep_started_at = excluded.sweep_started_at,
         sweep_heartbeat_at = excluded.sweep_heartbeat_at,
         sweep_expires_at = excluded.sweep_expires_at,
         epoch = image_registry_admission.epoch + 1,
         updated_at = excluded.updated_at
       WHERE image_registry_admission.state = 'open'
         AND image_registry_admission.paused_at IS NULL
       RETURNING epoch, sweep_token`,
    ).bind(
      REGISTRY_ADMISSION_KEY,
      REGISTRY_ADMISSION_PROTOCOL_VERSION,
      sweepToken,
      input.owner,
      now,
      expiresAtMs,
    ),
    env.DB.prepare(
      `INSERT INTO image_registry_gc_runs
         (id, owner, sweep_token, state, started_at, heartbeat_at, created_at,
          updated_at)
       SELECT ?1, ?2, ?3, 'running', ?4, ?4, ?4, ?4
        WHERE EXISTS (
              SELECT 1 FROM image_registry_admission
               WHERE key = ?5 AND state = 'sweeping' AND sweep_token = ?3)
       RETURNING id`,
    ).bind(runId, input.owner, sweepToken, now, REGISTRY_ADMISSION_KEY),
  ]);

  const marker = firstRow(results[1]);
  if (!marker) {
    const state = await readRegistryAdmissionState(env);
    return {
      ok: false,
      code: state.sweep.active ? "registry_sweep_active" : "registry_admission_busy",
      counts: state.counts,
      state,
    };
  }

  const state = await readRegistryAdmissionState(env);
  const blockedReason =
    state.enforcement === "enforce"
      ? registryAdmissionBlockedReason(state.counts)
      : "registry_enforcement_disabled";
  return {
    ok: true,
    counts: state.counts,
    lease: {
      sweepToken,
      epoch: numberFrom(marker.epoch),
      startedAtMs: now,
      expiresAtMs,
      heartbeatIntervalMs: REGISTRY_HEARTBEAT_INTERVAL_MS,
      deleteAllowed: blockedReason === null,
      blockedReason,
    },
  };
}

/**
 * Gate every delete batch. Deletion is all-or-nothing: an unresolved write
 * blocks every key, because a partially protected sweep cannot be reasoned
 * about later.
 */
export async function assertRegistrySweepDeletable(
  env: RegistryAdmissionEnv,
  input: { sweepToken: string; objectKeys: readonly string[] },
): Promise<
  | { ok: true; deletable: string[]; blocked: string[] }
  | { ok: false; code: string; deletable: string[]; blocked: string[] }
> {
  const state = await readRegistryAdmissionState(env);
  if (!state.sweep.active || state.sweep.token !== input.sweepToken) {
    return {
      ok: false,
      code: "registry_sweep_superseded",
      deletable: [],
      blocked: [...input.objectKeys],
    };
  }
  // A stalled heartbeat means this collector may already have lost its lease to
  // an operator decision. Stop the delete loop instead of relying on the timer.
  if (state.sweep.stalled) {
    return {
      ok: false,
      code: "registry_sweep_stalled",
      deletable: [],
      blocked: [...input.objectKeys],
    };
  }
  if (state.paused) {
    return {
      ok: false,
      code: "registry_paused",
      deletable: [],
      blocked: [...input.objectKeys],
    };
  }
  if (state.enforcement !== "enforce") {
    return {
      ok: false,
      code: "registry_enforcement_disabled",
      deletable: [],
      blocked: [...input.objectKeys],
    };
  }
  const blockedReason = registryAdmissionBlockedReason(state.counts);
  if (blockedReason) {
    return {
      ok: false,
      code: blockedReason,
      deletable: [],
      blocked: [...input.objectKeys],
    };
  }
  return { ok: true, deletable: [...input.objectKeys], blocked: [] };
}

export async function heartbeatRegistrySweep(
  env: RegistryAdmissionEnv,
  input: { sweepToken: string; leaseMs?: number },
): Promise<
  | { ok: true; expiresAtMs: number; deleteAllowed: boolean; blockedReason: string | null }
  | { ok: false; response: Response }
> {
  const now = Date.now();
  const expiresAtMs = now + (input.leaseMs ?? REGISTRY_SWEEP_LEASE_MS);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE image_registry_admission
          SET sweep_heartbeat_at = ?1, sweep_expires_at = ?2, updated_at = ?1
        WHERE key = ?3 AND state = 'sweeping' AND sweep_token = ?4
        RETURNING epoch`,
    ).bind(now, expiresAtMs, REGISTRY_ADMISSION_KEY, input.sweepToken),
    env.DB.prepare(
      `UPDATE image_registry_gc_runs
          SET heartbeat_at = ?1, updated_at = ?1
        WHERE sweep_token = ?2 AND state = 'running'
        RETURNING id`,
    ).bind(now, input.sweepToken),
  ]);
  if (!firstRow(results[0])) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "registry sweep is no longer current", code: "registry_sweep_superseded" },
        409,
      ),
    };
  }
  const state = await readRegistryAdmissionState(env);
  const blockedReason =
    state.enforcement === "enforce"
      ? registryAdmissionBlockedReason(state.counts)
      : "registry_enforcement_disabled";
  return {
    ok: true,
    expiresAtMs,
    deleteAllowed: blockedReason === null,
    blockedReason,
  };
}

export async function recordRegistryGcProgress(
  env: RegistryAdmissionEnv,
  input: {
    sweepToken: string;
    counters?: Partial<{
      scannedObjects: number;
      deletedObjects: number;
      blockedObjects: number;
      bytesReclaimed: number;
    }>;
    detail?: Record<string, unknown> | null;
  },
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const now = Date.now();
  const counters = input.counters ?? {};
  const rows = await env.DB.prepare(
    `UPDATE image_registry_gc_runs
        SET heartbeat_at = ?1,
            updated_at = ?1,
            scanned_objects = MAX(scanned_objects, ?2),
            deleted_objects = MAX(deleted_objects, ?3),
            blocked_objects = MAX(blocked_objects, ?4),
            bytes_reclaimed = MAX(bytes_reclaimed, ?5),
            detail_json = COALESCE(?6, detail_json)
      WHERE sweep_token = ?7 AND state = 'running'
      RETURNING id`,
  )
    .bind(
      now,
      counterValue(counters.scannedObjects),
      counterValue(counters.deletedObjects),
      counterValue(counters.blockedObjects),
      counterValue(counters.bytesReclaimed),
      input.detail ? JSON.stringify(input.detail) : null,
      input.sweepToken,
    )
    .all<{ id: string }>();
  if (!(rows.results ?? []).length) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "registry sweep is no longer current", code: "registry_sweep_superseded" },
        409,
      ),
    };
  }
  return { ok: true };
}

export async function finishRegistrySweep(
  env: RegistryAdmissionEnv,
  input: {
    sweepToken: string;
    outcome: Extract<ImageRegistryGcRunState, "completed" | "failed">;
    error?: string | null;
    counters?: Partial<{
      scannedObjects: number;
      deletedObjects: number;
      blockedObjects: number;
      bytesReclaimed: number;
    }>;
  },
): Promise<{ ok: boolean }> {
  const now = Date.now();
  const counters = input.counters ?? {};
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE image_registry_admission
          SET state = 'open',
              sweep_token = NULL,
              sweep_owner = NULL,
              sweep_started_at = NULL,
              sweep_heartbeat_at = NULL,
              sweep_expires_at = NULL,
              updated_at = ?1
        WHERE key = ?2 AND state = 'sweeping' AND sweep_token = ?3
        RETURNING epoch`,
    ).bind(now, REGISTRY_ADMISSION_KEY, input.sweepToken),
    env.DB.prepare(
      `UPDATE image_registry_gc_runs
          SET state = ?1,
              finished_at = ?2,
              heartbeat_at = ?2,
              error = COALESCE(?3, error),
              updated_at = ?2,
              scanned_objects = MAX(scanned_objects, ?4),
              deleted_objects = MAX(deleted_objects, ?5),
              blocked_objects = MAX(blocked_objects, ?6),
              bytes_reclaimed = MAX(bytes_reclaimed, ?7)
        WHERE sweep_token = ?8 AND state = 'running'
        RETURNING id`,
    ).bind(
      input.outcome,
      now,
      input.error ?? null,
      counterValue(counters.scannedObjects),
      counterValue(counters.deletedObjects),
      counterValue(counters.blockedObjects),
      counterValue(counters.bytesReclaimed),
      input.sweepToken,
    ),
  ]);
  return { ok: Boolean(firstRow(results[0])) };
}

function counterValue(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function firstRow(
  result: D1Result<unknown> | undefined,
): Record<string, unknown> | undefined {
  const rows = result?.results;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const row = rows[0];
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : undefined;
}

function rowCount(result: D1Result<unknown> | undefined): number {
  return result?.results?.length ?? 0;
}

function rowIds(
  result: D1Result<unknown> | undefined,
  column: string,
): string[] {
  return (result?.results ?? [])
    .map((row) =>
      typeof row === "object" && row !== null && column in row
        ? String((row as Record<string, unknown>)[column])
        : null,
    )
    .filter((value): value is string => value !== null);
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
