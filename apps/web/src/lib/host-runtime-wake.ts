import { env } from "cloudflare:workers";
import {
  tryWakeHostRuntimeViaNamespace,
  wakeHostRuntimeViaNamespace,
} from "@/lib/host-runtime-wake-client";

const HOST_RUNTIME_WAKE_TIMEOUT_MS = 10_000;

export async function wakeHostRuntime(hostId: string): Promise<void> {
  await wakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId);
}

export async function tryWakeHostRuntime(hostId: string): Promise<void> {
  await tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId);
}

export async function retireHostRuntime(hostId: string): Promise<void> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const response = await withTimeout(
    stub.fetch(
      new Request("https://host-runtime.internal/_internal/retire", {
        method: "POST",
        headers: { "x-agent-host-id": hostId },
      }),
    ),
    HOST_RUNTIME_WAKE_TIMEOUT_MS,
    `host runtime retirement timed out for ${hostId}`,
  );
  if (!response.ok) {
    throw new Error(
      `host runtime retirement failed for ${hostId}: ${response.status}`,
    );
  }
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
