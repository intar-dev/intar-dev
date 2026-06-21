import { env } from "cloudflare:workers";
import { and, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { hostRpcCalls } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

const VM_LAUNCH_TIMEOUT_MS = 30 * 60 * 1000;
const VM_DESTROY_TIMEOUT_MS = 30 * 60 * 1000;
const VM_LIST_TIMEOUT_MS = 60 * 1000;
const VM_TERMINAL_GET_TIMEOUT_MS = 10 * 1000;
const VM_TERMINAL_REPORT_TIMEOUT_MS = 10 * 1000;
const HOST_PING_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CALL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_RUNTIME_WAKE_TIMEOUT_MS = 10_000;

export type HostRpcMethod =
  | "vm.launch"
  | "vm.destroy"
  | "vm.list"
  | "vm.terminal.get"
  | "vm.terminal.report"
  | "host.ping";

export type HostRpcDirection = "server_to_host" | "host_to_server";

export type HostRpcStatus =
  | "queued"
  | "sent"
  | "request_acked"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out";

export interface HostRpcCallRecord {
  callId: string;
  hostId: string;
  userId: string | null;
  runId: string | null;
  vmId: string | null;
  direction: HostRpcDirection;
  method: HostRpcMethod;
  status: HostRpcStatus;
  idempotencyKey: string | null;
  requestMessageId: string | null;
  responseMessageId: string | null;
  request: Record<string, unknown>;
  response: unknown;
  error: unknown;
  requestAckedAt: number | null;
  responseAckedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  deadlineAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateHostRpcCallInput {
  callId?: string;
  hostId: string;
  userId?: string | null;
  runId?: string | null;
  vmId?: string | null;
  method: HostRpcMethod;
  request: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export function isHostRpcMethod(value: string): value is HostRpcMethod {
  return (
    value === "vm.launch" ||
    value === "vm.destroy" ||
    value === "vm.list" ||
    value === "vm.terminal.get" ||
    value === "vm.terminal.report" ||
    value === "host.ping"
  );
}

export async function createHostRpcCall(
  input: CreateHostRpcCallInput,
): Promise<HostRpcCallRecord> {
  const [record] = await createHostRpcCalls([input]);
  if (!record) {
    throw appError(
      500,
      "host_rpc_call_create_failed",
      "host RPC call was not created",
    );
  }
  return record;
}

export async function createHostRpcCalls(
  inputs: CreateHostRpcCallInput[],
): Promise<HostRpcCallRecord[]> {
  if (!inputs.length) {
    return [];
  }

  const db = drizzle(env.DB);
  const nowMs = Date.now();
  const prunedHosts = new Set<string>();
  const records: HostRpcCallRecord[] = [];
  const hostIdsToWake = new Set<string>();

  for (const input of inputs) {
    if (!prunedHosts.has(input.hostId)) {
      await db
        .delete(hostRpcCalls)
        .where(
          and(
            eq(hostRpcCalls.hostId, input.hostId),
            lt(hostRpcCalls.expiresAt, nowMs),
          ),
        );
      prunedHosts.add(input.hostId);
    }

    const idempotencyKey = sanitizeKey(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = await loadHostRpcCallByIdempotencyKey({
        hostId: input.hostId,
        idempotencyKey,
      });
      if (existing && (!existing.expiresAt || existing.expiresAt >= nowMs)) {
        hostIdsToWake.add(input.hostId);
        records.push(existing);
        continue;
      }
    }

    const callId = input.callId ?? createAppId();
    const timeoutMs = timeoutForMethod(input.method);
    const deadlineAt = nowMs + timeoutMs;
    const expiresAt = deadlineAt + DEFAULT_CALL_RETENTION_MS;

    await db.insert(hostRpcCalls).values({
      callId,
      hostId: input.hostId,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      vmId: input.vmId ?? null,
      direction: "server_to_host",
      method: input.method,
      status: "queued",
      idempotencyKey,
      requestMessageId: null,
      responseMessageId: null,
      requestJson: JSON.stringify(input.request),
      responseJson: null,
      errorJson: null,
      requestAckedAt: null,
      responseAckedAt: null,
      startedAt: null,
      finishedAt: null,
      deadlineAt,
      expiresAt,
      createdAt: nowMs,
      updatedAt: nowMs,
    });

    records.push(await loadRequiredHostRpcCall(callId));
    hostIdsToWake.add(input.hostId);
  }

  await Promise.all(
    [...hostIdsToWake].map((hostId) => tryWakeHostRuntime(hostId)),
  );
  return records;
}

export async function createServerRpcCall(input: CreateHostRpcCallInput) {
  return createHostRpcCall(input);
}

export async function createServerRpcCalls(inputs: CreateHostRpcCallInput[]) {
  return createHostRpcCalls(inputs);
}

export async function wakeHostRuntime(hostId: string): Promise<void> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const request = new Request("https://host-runtime.internal/_internal/wake", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ hostId }),
  });

  await withTimeout(
    stub.fetch(request),
    HOST_RUNTIME_WAKE_TIMEOUT_MS,
    `host runtime wake timed out for ${hostId}`,
  );
}

export async function tryWakeHostRuntime(hostId: string): Promise<void> {
  try {
    await wakeHostRuntime(hostId);
  } catch {
    // best-effort wake only; the persisted call ledger remains authoritative
  }
}

export async function loadHostRpcCallForUser(params: {
  callId: string;
  hostId: string;
  userId: string;
}): Promise<HostRpcCallRecord | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(hostRpcCalls)
    .where(
      and(
        eq(hostRpcCalls.callId, params.callId),
        eq(hostRpcCalls.hostId, params.hostId),
        eq(hostRpcCalls.userId, params.userId),
      ),
    )
    .limit(1);

  return rows[0] ? toCallRecord(rows[0]) : null;
}

export async function listHostRpcCallsForHostUser(params: {
  hostId: string;
  userId: string;
  limit?: number;
}): Promise<HostRpcCallRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(hostRpcCalls)
    .where(
      and(
        eq(hostRpcCalls.hostId, params.hostId),
        eq(hostRpcCalls.userId, params.userId),
      ),
    )
    .orderBy(desc(hostRpcCalls.createdAt))
    .limit(Math.max(1, Math.min(params.limit ?? 20, 100)));

  return rows.map(toCallRecord);
}

export async function loadRequiredHostRpcCall(
  callId: string,
): Promise<HostRpcCallRecord> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(hostRpcCalls)
    .where(eq(hostRpcCalls.callId, callId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw appError(404, "host_rpc_call_not_found", "host RPC call not found");
  }
  return toCallRecord(row);
}

export async function loadHostRpcCallByIdempotencyKey(params: {
  hostId: string;
  idempotencyKey: string;
}): Promise<HostRpcCallRecord | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(hostRpcCalls)
    .where(
      and(
        eq(hostRpcCalls.hostId, params.hostId),
        eq(hostRpcCalls.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);

  return rows[0] ? toCallRecord(rows[0]) : null;
}

function timeoutForMethod(method: HostRpcMethod): number {
  switch (method) {
    case "vm.launch":
      return VM_LAUNCH_TIMEOUT_MS;
    case "vm.destroy":
      return VM_DESTROY_TIMEOUT_MS;
    case "vm.list":
      return VM_LIST_TIMEOUT_MS;
    case "vm.terminal.get":
      return VM_TERMINAL_GET_TIMEOUT_MS;
    case "vm.terminal.report":
      return VM_TERMINAL_REPORT_TIMEOUT_MS;
    case "host.ping":
      return HOST_PING_TIMEOUT_MS;
  }
}

function sanitizeKey(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toCallRecord(
  row: typeof hostRpcCalls.$inferSelect,
): HostRpcCallRecord {
  const request = parseJson(row.requestJson);
  return {
    callId: row.callId,
    hostId: row.hostId,
    userId: row.userId,
    runId: row.runId,
    vmId: row.vmId,
    direction: row.direction as HostRpcDirection,
    method: row.method as HostRpcMethod,
    status: row.status as HostRpcStatus,
    idempotencyKey: row.idempotencyKey,
    requestMessageId: row.requestMessageId,
    responseMessageId: row.responseMessageId,
    request:
      request && typeof request === "object" && !Array.isArray(request)
        ? (request as Record<string, unknown>)
        : {},
    response: parseJson(row.responseJson),
    error: parseJson(row.errorJson),
    requestAckedAt: row.requestAckedAt,
    responseAckedAt: row.responseAckedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    deadlineAt: row.deadlineAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
