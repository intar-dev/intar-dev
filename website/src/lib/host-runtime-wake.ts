import { env } from "cloudflare:workers";

const HOST_RUNTIME_WAKE_TIMEOUT_MS = 10_000;

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
    // Best-effort wake only; desired state remains authoritative.
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
