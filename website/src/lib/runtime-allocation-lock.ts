import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

export const RUNTIME_CAPACITY_ALLOCATION_LOCK_TTL_MS = 5 * 60_000;

const DEFAULT_LOCK_TTL_MS = RUNTIME_CAPACITY_ALLOCATION_LOCK_TTL_MS;

export function runtimeCapacityAllocationKey(
  organizationId: string | null | undefined,
): string {
  const normalized = organizationId?.trim();
  return normalized
    ? `runtime-capacity:organization:${normalized}`
    : "runtime-capacity:unscoped";
}

export async function withRuntimeAllocationLock<T>(input: {
  key: string;
  operation: () => Promise<T>;
  now?: number;
  ttlMs?: number;
}): Promise<T> {
  const key = required(input.key, "key");
  const ownerToken = createAppId();
  const now = timestamp(input.now ?? Date.now(), "now");
  const ttlMs = positiveInteger(input.ttlMs ?? DEFAULT_LOCK_TTL_MS, "ttlMs");
  const acquired = await env.DB.prepare(
    `INSERT INTO runtime_allocation_locks (
       key, owner_token, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       owner_token = excluded.owner_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE runtime_allocation_locks.expires_at <= ?
        OR runtime_allocation_locks.owner_token = excluded.owner_token`,
  )
    .bind(key, ownerToken, now + ttlMs, now, now, now)
    .run();
  if ((acquired.meta.changes ?? 0) !== 1) {
    throw appError(
      409,
      "runtime_allocation_busy",
      "runtime capacity is being allocated concurrently; retry shortly",
    );
  }
  try {
    return await input.operation();
  } finally {
    await env.DB.prepare(
      "DELETE FROM runtime_allocation_locks WHERE key = ? AND owner_token = ?",
    )
      .bind(key, ownerToken)
      .run();
  }
}

function required(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw appError(400, "runtime_allocation_invalid", `${label} is required`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw appError(
      400,
      "runtime_allocation_invalid",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(
      400,
      "runtime_allocation_invalid",
      `${label} must be a Unix millisecond timestamp`,
    );
  }
  return value;
}
