const HOST_RUNTIME_WAKE_TIMEOUT_MS = 10_000;

/**
 * Worker-runtime client that is safe to import from Node validation modules.
 * The caller supplies the namespace instead of this module importing
 * cloudflare:workers at module initialization time.
 */
export async function wakeHostRuntimeViaNamespace(
  namespace: DurableObjectNamespace,
  hostId: string,
): Promise<void> {
  const stub = namespace.get(namespace.idFromName(hostId));
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

export async function tryWakeHostRuntimeViaNamespace(
  namespace: DurableObjectNamespace,
  hostId: string,
): Promise<void> {
  try {
    await wakeHostRuntimeViaNamespace(namespace, hostId);
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
