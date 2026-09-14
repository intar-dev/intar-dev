import {
  REGISTRY_ADMISSION_PROTOCOL_VERSION,
  REGISTRY_HEARTBEAT_INTERVAL_MS,
  REGISTRY_OPERATION_LEASE_MS,
  REGISTRY_SESSION_HEADER,
  REGISTRY_SESSION_LEASE_MS,
  REGISTRY_SWEEP_LEASE_MS,
  completeRegistryUploadSession,
  createRegistryUploadSession,
  heartbeatRegistryUploadSession,
  readRegistryAdmissionState,
  readRegistryAuth,
  readRegistryIdleState,
  readRegistrySessionId,
  reapRegistryAdmission,
  registryAdmissionBlockedReason,
  setRegistryEnforcement,
  setRegistryPause,
} from "@/lib/image-registry-admission";
import { isRecord, jsonResponse, readString } from "./shared";

/**
 * Upload-session and admission-control HTTP surface. The session header carries
 * an opaque id only; the owner always comes from the verified credential.
 */

export async function handleUploadSessionCreate(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readOptionalJsonRecord(request);
  if (!body.ok) return body.response;
  const intent = readString(body.value?.intent);

  const created = await createRegistryUploadSession(env, {
    owner: auth.owner,
    intent,
  });
  if (!created.ok) return created.response;

  const state = await readRegistryAdmissionState(env);
  return jsonResponse(admissionResponse(state, created.sessionId), 201);
}

export async function handleUploadSessionHeartbeat(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  const sessionId = readRegistrySessionId(request);
  if (!sessionId) return sessionRequiredResponse();

  const heartbeated = await heartbeatRegistryUploadSession(env, {
    owner: auth.owner,
    sessionId,
  });
  if (!heartbeated.ok) return heartbeated.response;

  const state = await readRegistryAdmissionState(env);
  return jsonResponse(admissionResponse(state, sessionId, heartbeated.expiresAtMs));
}

export async function handleUploadSessionComplete(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  const sessionId = readRegistrySessionId(request);
  if (!sessionId) return sessionRequiredResponse();

  const body = await readOptionalJsonRecord(request);
  if (!body.ok) return body.response;
  const outcome = body.value?.outcome ?? "published";
  if (outcome !== "published" && outcome !== "abandoned") {
    return jsonResponse(
      { error: "outcome must be published or abandoned" },
      400,
    );
  }

  const completed = await completeRegistryUploadSession(env, {
    owner: auth.owner,
    sessionId,
    outcome,
  });
  if (!completed.ok) return completed.response;

  return jsonResponse({
    ok: true,
    session_id: sessionId,
    state: completed.state,
    released_writers: completed.releasedWriters,
  });
}

export async function handleRegistryAdmissionStatus(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  const [state, idle] = await Promise.all([
    readRegistryAdmissionState(env),
    readRegistryIdleState(env),
  ]);
  return jsonResponse({
    ok: true,
    protocol_version: state.protocolVersion,
    session_header: REGISTRY_SESSION_HEADER,
    enforcement: state.enforcement,
    session_required: state.enforcement === "enforce",
    paused: state.paused,
    pause_reason: state.pauseReason,
    idle: idle.idle,
    idle_blocked_reason: idle.blockedReason,
    session_lease_ms: REGISTRY_SESSION_LEASE_MS,
    writer_lease_ms: REGISTRY_OPERATION_LEASE_MS,
    sweep_lease_ms: REGISTRY_SWEEP_LEASE_MS,
    heartbeat_interval_ms: REGISTRY_HEARTBEAT_INTERVAL_MS,
    sweep: {
      active: state.sweep.active,
      stalled: state.sweep.stalled,
      owner: state.sweep.owner,
      started_at_unix_ms: state.sweep.startedAtMs,
      heartbeat_at_unix_ms: state.sweep.heartbeatAtMs,
      expires_at_unix_ms: state.sweep.expiresAtMs,
    },
    active: {
      sessions: state.counts.openSessions,
      writers: state.counts.pendingWriters,
    },
    pending: {
      stale_sessions: state.counts.staleOpenSessions,
      stale_writers: state.counts.stalePendingWriters,
      unknown_writers: state.counts.unknownWriters,
      delete_blocked_reason: registryAdmissionBlockedReason(state.counts),
    },
  });
}

export async function handleRegistryAdmissionPause(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  if (auth.owner.kind !== "publish_token") {
    return jsonResponse({ error: "registry publish token required" }, 403);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return body.response;
  if (typeof body.value.paused !== "boolean") {
    return jsonResponse({ error: "paused must be a boolean" }, 400);
  }
  const reason = readString(body.value.reason);
  const paused = await setRegistryPause(env, {
    paused: body.value.paused,
    reason,
  });
  const idle = await readRegistryIdleState(env);
  return jsonResponse({
    ok: true,
    paused: paused.paused,
    pause_reason: paused.reason,
    idle: idle.idle,
    idle_blocked_reason: idle.blockedReason,
  });
}

export async function handleRegistryAdmissionEnforcement(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  if (auth.owner.kind !== "publish_token") {
    return jsonResponse({ error: "registry publish token required" }, 403);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return body.response;
  const mode = body.value.mode;
  if (mode !== "report_only" && mode !== "enforce") {
    return jsonResponse({ error: "mode must be report_only or enforce" }, 400);
  }
  await setRegistryEnforcement(env, mode);
  const state = await readRegistryAdmissionState(env);
  return jsonResponse({
    ok: true,
    enforcement: state.enforcement,
    session_required: state.enforcement === "enforce",
    sweep_active: state.sweep.active,
  });
}

export async function handleRegistryAdmissionReap(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  if (auth.owner.kind !== "publish_token") {
    return jsonResponse({ error: "registry publish token required" }, 403);
  }
  const body = await readOptionalJsonRecord(request);
  if (!body.ok) return body.response;
  const graceMs = readOptionalNonNegativeInteger(body.value?.grace_ms);
  if (graceMs === "invalid") {
    return jsonResponse({ error: "grace_ms must be a non-negative integer" }, 400);
  }

  // Resolving a stalled sweep is opt-in. The fail-closed default leaves the gate
  // held until an operator says otherwise.
  const reaped = await reapRegistryAdmission(env, {
    ...(graceMs === undefined ? {} : { graceMs }),
    resolveStalledSweeps: body.value?.resolve_stalled_sweeps === true,
  });
  const state = await readRegistryAdmissionState(env);
  return jsonResponse({
    ok: true,
    reaped_sessions: reaped.reapedSessions,
    reaped_writers: reaped.reapedWriters,
    resolved_sweeps: reaped.resolvedSweeps,
    compacted_sessions: reaped.compactedSessions,
    active: {
      sessions: state.counts.openSessions,
      writers: state.counts.pendingWriters,
    },
    sweep_active: state.sweep.active,
    sweep_stalled: state.sweep.stalled,
  });
}

function admissionResponse(
  state: Awaited<ReturnType<typeof readRegistryAdmissionState>>,
  sessionId: string,
  expiresAtMs?: number,
): Record<string, unknown> {
  return {
    ok: true,
    session_id: sessionId,
    state: "open",
    expires_at_unix_ms:
      expiresAtMs ?? Date.now() + REGISTRY_SESSION_LEASE_MS,
    heartbeat_interval_ms: REGISTRY_HEARTBEAT_INTERVAL_MS,
    protocol: {
      version: state.protocolVersion || REGISTRY_ADMISSION_PROTOCOL_VERSION,
      session_required: state.enforcement === "enforce",
      enforcement: state.enforcement,
    },
  };
}

function sessionRequiredResponse(): Response {
  return jsonResponse(
    {
      error: "registry upload session is required",
      code: "registry_session_required",
      session_header: REGISTRY_SESSION_HEADER,
    },
    400,
  );
}

async function readJsonRecord(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "JSON body is required" }, 400),
    };
  }
  return isRecord(value)
    ? { ok: true, value }
    : {
        ok: false,
        response: jsonResponse({ error: "JSON body is required" }, 400),
      };
}

async function readOptionalJsonRecord(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; response: Response }
> {
  const raw = await request.text();
  if (!raw.trim()) return { ok: true, value: null };
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value)
      ? { ok: true, value }
      : {
          ok: false,
          response: jsonResponse({ error: "JSON body is required" }, 400),
        };
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "JSON body is required" }, 400),
    };
  }
}

function readOptionalNonNegativeInteger(
  value: unknown,
): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : "invalid";
}
