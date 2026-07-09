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
  } catch (error) {
    // Best-effort wake only; desired state remains authoritative. Keep the
    // failure observable so repeated DO routing or availability faults do not
    // disappear behind a successful control-plane response.
    console.warn(
      JSON.stringify({
        message: "host runtime wake failed",
        hostId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
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
