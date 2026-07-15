import { env } from "cloudflare:workers";
import type { HostCpuReservationCapacity } from "@/control-plane/host-cpu-reservations";

const HOST_CPU_RESERVATION_TIMEOUT_MS = 10_000;

export type HostCpuReservationResult =
  | {
      ok: true;
      state: "pending" | "committed";
      expiresAt: number | null;
      capacity: HostCpuReservationCapacity;
    }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "boot_capacity_pending"
        | "conflict";
      capacity: HostCpuReservationCapacity | null;
    };

export async function reserveHostCpu(input: {
  hostId: string;
  runId: string;
  steadyCpuMillisByVm: readonly number[];
}): Promise<HostCpuReservationResult> {
  return reservationRequest<HostCpuReservationResult>(
    input.hostId,
    "reserve",
    input,
  );
}

export async function commitHostCpu(input: {
  hostId: string;
  runId: string;
}): Promise<void> {
  const result = await reservationRequest<{ ok: boolean }>(
    input.hostId,
    "commit",
    input,
  );
  if (!result.ok) {
    throw new Error(`host CPU reservation is missing for run ${input.runId}`);
  }
}

export async function rollbackHostCpu(input: {
  hostId: string;
  runId: string;
}): Promise<void> {
  await reservationRequest<{ ok: boolean }>(input.hostId, "rollback", input);
}

async function reservationRequest<T>(
  hostId: string,
  operation: "reserve" | "commit" | "rollback",
  body: Record<string, unknown>,
): Promise<T> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const response = await withTimeout(
    stub.fetch(
      new Request(
        `https://host-runtime.internal/_internal/cpu-reservations/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    ),
    HOST_CPU_RESERVATION_TIMEOUT_MS,
    `host CPU reservation ${operation} timed out for ${hostId}`,
  );
  const parsed = (await response.json()) as T;
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `host CPU reservation ${operation} failed for ${hostId}: ${response.status}`,
    );
  }
  return parsed;
}

class HostCpuReservationTimeoutError extends Error {
  override readonly name = "HostCpuReservationTimeoutError";
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
        timer = setTimeout(
          () => reject(new HostCpuReservationTimeoutError(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
